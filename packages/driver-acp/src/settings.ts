import type { InteractionMode, ModelInfo, RuntimeMode } from "@tide/contracts";
import type { AcpConnection } from "./jsonrpc.ts";
import { effortSelector, modelSelector, type EffortSelector, type ModelSelector } from "./models.ts";
import { modeSelector, planModeId, targetModeId, type ModeSelector } from "./permissions.ts";
import type { AcpConfigOption, AcpLegacyModels, AcpModes } from "./types.ts";

/**
 * A session's agent-side knobs (mode, model, effort) as the agent reported them in
 * `session/new|load`, `session/set_config_option` replies and `config_option_update`, and the
 * best-effort calls that move them to what the thread wants.
 */

export interface SessionKnobs {
  modes?: AcpModes | null;
  configOptions?: AcpConfigOption[] | null;
  models?: AcpLegacyModels | null;
}

export interface WantedSettings {
  model?: string | undefined;
  effort?: string | undefined;
  mode: RuntimeMode;
  interaction: InteractionMode;
}

export class AcpSettings {
  #conn: AcpConnection;
  #sessionId: string;
  #log: (message: string) => void;
  #configOptions: AcpConfigOption[] | undefined;
  #modes: AcpModes | undefined;
  #legacyModels: AcpLegacyModels | undefined;
  /** the mode the agent started in: "default interaction, no special runtime mode" */
  #baseMode: string | undefined;
  #currentMode: string | undefined;
  #defaultModel: string | undefined;

  constructor(conn: AcpConnection, sessionId: string, knobs: SessionKnobs, log: (message: string) => void, defaultModel?: string) {
    this.#conn = conn;
    this.#sessionId = sessionId;
    this.#log = log;
    this.#defaultModel = defaultModel;
    this.ingest(knobs);
    this.#baseMode = this.#currentMode;
  }

  ingest(knobs: SessionKnobs): void {
    if (Array.isArray(knobs.configOptions)) this.#configOptions = knobs.configOptions;
    if (knobs.modes) this.#modes = knobs.modes;
    if (knobs.models) this.#legacyModels = knobs.models;
    const selector = this.modeSelector;
    if (selector) this.#currentMode = selector.current;
  }

  /** `current_mode_update`: the agent moved itself (e.g. after an `exit_plan_mode` tool). */
  modeChanged(modeId: string): void {
    this.#currentMode = modeId;
    if (this.#modes) this.#modes = { ...this.#modes, currentModeId: modeId };
  }

  get modeSelector(): ModeSelector | undefined {
    return modeSelector(this.#modes, this.#configOptions);
  }

  get models(): ModelSelector | undefined {
    return modelSelector(this.#configOptions, this.#legacyModels, this.#defaultModel);
  }

  get efforts(): EffortSelector | undefined {
    return effortSelector(this.#configOptions);
  }

  get planSupported(): boolean {
    return planModeId(this.modeSelector) !== undefined;
  }

  get currentModel(): string | undefined {
    return this.models?.current;
  }

  get modelList(): ModelInfo[] {
    return this.models?.models ?? [];
  }

  async #setConfig(configId: string, value: string): Promise<void> {
    const reply = await this.#conn.request<{ configOptions?: AcpConfigOption[] } | null>("session/set_config_option", { sessionId: this.#sessionId, configId, value });
    if (reply && Array.isArray(reply.configOptions)) this.#configOptions = reply.configOptions;
    else this.#configOptions = this.#configOptions?.map((option) => (option.id === configId ? { ...option, currentValue: value } : option));
  }

  async #setModel(model: string): Promise<void> {
    const selector = this.models;
    if (!selector) {
      this.#log(`model ${model} requested but the agent exposes no model selector; ignored`);
      return;
    }
    if (selector.current === model) return;
    if (selector.kind === "config" && selector.configId) await this.#setConfig(selector.configId, model);
    else {
      await this.#conn.request("session/set_model", { sessionId: this.#sessionId, modelId: model });
      if (this.#legacyModels) this.#legacyModels = { ...this.#legacyModels, currentModelId: model };
    }
  }

  async #setEffort(effort: string): Promise<void> {
    const selector = this.efforts;
    if (!selector) {
      this.#log(`effort ${effort} requested but the agent exposes no thought_level option; ignored`);
      return;
    }
    if (selector.current !== effort) await this.#setConfig(selector.configId, effort);
  }

  async #setMode(modeId: string): Promise<void> {
    const selector = this.modeSelector;
    if (!selector || this.#currentMode === modeId) return;
    if (selector.kind === "config" && selector.configId) await this.#setConfig(selector.configId, modeId);
    else await this.#conn.request("session/set_mode", { sessionId: this.#sessionId, modeId });
    this.modeChanged(modeId);
  }

  /**
   * Moves the agent towards `wanted`. Every knob is independent and best-effort: a failure is
   * logged and reported (false), never thrown, so a picky agent cannot block a session.
   */
  async apply(wanted: WantedSettings): Promise<boolean> {
    let ok = true;
    const attempt = async (what: string, run: () => Promise<void>): Promise<void> => {
      try {
        await run();
      } catch (error) {
        ok = false;
        this.#log(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const model = wanted.model ?? this.#defaultModel;
    if (model !== undefined) await attempt(`set model ${model}`, () => this.#setModel(model));
    if (wanted.effort !== undefined) {
      const effort = wanted.effort;
      await attempt(`set effort ${effort}`, () => this.#setEffort(effort));
    }
    const modeId = targetModeId(this.modeSelector, this.#baseMode, wanted.mode, wanted.interaction);
    if (modeId !== undefined) await attempt(`set mode ${modeId}`, () => this.#setMode(modeId));
    return ok;
  }
}
