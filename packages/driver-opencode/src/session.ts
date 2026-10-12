import type {
  ApprovalDecision,
  DriverEnv,
  NormalizedEvent,
  OpenSessionOptions,
  ProviderSession,
  ReconfigureResult,
  SessionSettings,
  TurnInput,
} from "@tide/contracts";
import { AsyncQueue } from "./async-queue.ts";
import type { EventHub } from "./hub.ts";
import { OpencodeNormalizer, ZERO_TOKENS } from "./normalize.ts";
import { grantCovers, replyFor, sessionRuleset, userRules, type SessionGrant } from "./permissions.ts";
import type { OpencodeApi, PromptFile } from "./types.ts";
import type { EventOf, FormValue, ModelRef, OpencodeEvent, PermissionRule, WireConfigEntry, WireForm, WireTokens } from "./wire.ts";

export interface AgentChoice {
  /** agent for `interaction: default` — the user's `default_agent` or first primary agent */
  build: string;
  /** agent for `interaction: plan`, when the server has one */
  plan?: string;
}

export interface SessionDeps {
  api: OpencodeApi;
  hub: EventHub;
  agents: AgentChoice;
  /** the user's config entries, for replaying their rules (see `permissions.ts`) */
  config?: WireConfigEntry[];
  model?: ModelRef;
  contextWindow?: number;
  /** resolves `provider/model` ids for `reconfigure` (catalog lookup lives in the instance) */
  resolveModel?: (id: string | undefined) => Promise<{ model?: ModelRef; contextWindow?: number }>;
  /** cumulative usage of a resumed session, so the first turn reports a delta */
  baseline?: { cost: number; tokens: WireTokens };
  /** thread-scoped MCP registrations to remove on close */
  mcpNames?: string[];
  onClosed?: (session: OpencodeSession) => void;
}

function promptFiles(input: TurnInput): PromptFile[] {
  return (input.images ?? []).map((image, index) => ({ uri: `data:${image.mediaType};base64,${image.data}`, name: `image-${index + 1}` }));
}

export function agentFor(choice: AgentChoice, interaction: SessionSettings["interaction"]): string {
  return interaction === "plan" ? (choice.plan ?? choice.build) : choice.build;
}

/**
 * One OpenCode 2 session. Turns are serial: `send()` admits a prompt and the hub's event
 * stream is the only completion signal (`session.execution.*`), so a second concurrent turn
 * is refused rather than interleaving two `settled`s.
 */
export class OpencodeSession implements ProviderSession {
  nativeSessionId: string;

  #env: DriverEnv;
  #options: OpenSessionOptions;
  #deps: SessionDeps;
  #settings: SessionSettings;
  #agent: string;
  #mailbox: AsyncQueue<NormalizedEvent> | undefined;
  #normalizer: OpencodeNormalizer | undefined;
  #baseline: { cost: number; tokens: WireTokens };
  #forms = new Map<string, WireForm>();
  #pending = new Map<string, { action: string; resources: string[]; save: string[] }>();
  #grants: SessionGrant[] = [];
  #unsubscribe: () => void;
  #turnActive = false;
  #closed = false;

  constructor(env: DriverEnv, options: OpenSessionOptions, deps: SessionDeps, sessionId: string) {
    this.#env = env;
    this.#options = options;
    this.#deps = deps;
    this.#settings = { ...(options.model !== undefined ? { model: options.model } : {}), mode: options.mode, interaction: options.interaction };
    this.#agent = agentFor(deps.agents, options.interaction);
    this.#baseline = deps.baseline ?? { cost: 0, tokens: ZERO_TOKENS };
    this.nativeSessionId = sessionId;
    this.#unsubscribe = deps.hub.add(sessionId, { onEvent: (event) => this.#onEvent(event), onStreamEnd: (reason) => this.#onStreamEnd(reason) }, true);
  }

  get agent(): string {
    return this.#agent;
  }

  /** The ruleset this session should carry for the given settings. */
  ruleset(settings: SessionSettings = this.#settings): PermissionRule[] {
    const agent = agentFor(this.#deps.agents, settings.interaction);
    return sessionRuleset(settings.mode, settings.interaction, this.#options.cwd, this.#options.linkedDirs ?? [], userRules(this.#deps.config, agent));
  }

  send(input: TurnInput): AsyncIterable<NormalizedEvent> {
    if (this.#closed) throw new Error("opencode session is closed");
    if (this.#turnActive) throw new Error("busy: a turn is already running on this opencode session");
    this.#turnActive = true;
    const mailbox = new AsyncQueue<NormalizedEvent>();
    this.#mailbox = mailbox;
    this.#normalizer = new OpencodeNormalizer({
      sessionId: this.nativeSessionId,
      directory: this.#options.cwd,
      baseline: this.#baseline,
      ...(this.#deps.contextWindow !== undefined ? { contextWindow: this.#deps.contextWindow } : {}),
      onUnknown: (type) => {
        if (process.env["TIDE_DEBUG_OPENCODE"]) this.#env.log(`[opencode] unhandled event ${type}`);
      },
    });
    const self = this;
    async function* stream(): AsyncGenerator<NormalizedEvent, void> {
      const pump = self.#pump(mailbox, input);
      try {
        const model = self.#deps.model;
        yield { type: "session", nativeSessionId: self.nativeSessionId, ...(model ? { model: `${model.providerID}/${model.id}` } : {}) };
        for await (const event of mailbox.drain()) yield event;
        await pump;
      } finally {
        const latest = self.#normalizer?.latestUsage;
        if (latest) self.#baseline = latest;
        self.#turnActive = false;
        self.#mailbox = undefined;
        self.#normalizer = undefined;
      }
    }
    return stream();
  }

  async #pump(mailbox: AsyncQueue<NormalizedEvent>, input: TurnInput): Promise<void> {
    try {
      // Subscribe before prompting: the stream is the only place a turn's events appear.
      await this.#deps.hub.ensure();
      const files = promptFiles(input);
      await this.#deps.api.prompt({ sessionId: this.nativeSessionId, text: input.text, ...(files.length > 0 ? { files } : {}) });
    } catch (error) {
      this.#push(this.#normalizer?.abort(error instanceof Error ? error.message : String(error)) ?? []);
      mailbox.close();
    }
  }

  #push(events: NormalizedEvent[]): void {
    const mailbox = this.#mailbox;
    if (!mailbox) return;
    for (const event of events) {
      mailbox.push(event);
      if (event.type === "settled") mailbox.close();
    }
  }

  #onEvent(event: OpencodeEvent): void {
    if (event.type === "form.created") {
      const form = (event as EventOf<"form.created">).data.form as unknown as WireForm;
      this.#forms.set(form.id, form);
    }
    if (event.type === "permission.asked") {
      const asked = (event as EventOf<"permission.asked">).data;
      // "accept for session": answered here, never surfaced again for this session
      if (grantCovers(this.#grants, asked.action, asked.resources)) {
        void this.#reply(asked.id, "once");
        return;
      }
      this.#pending.set(asked.id, { action: asked.action, resources: asked.resources, save: asked.save ?? [] });
    }
    this.#push(this.#normalizer?.next(event) ?? []);
  }

  /** The hub's stream died (server gone): the running turn can never settle on its own. */
  #onStreamEnd(reason: string): void {
    this.#push(this.#normalizer?.abort(reason) ?? []);
  }

  async #reply(requestId: string, decision: "once" | "always" | "reject"): Promise<void> {
    try {
      await this.#deps.api.replyPermission({ sessionId: this.nativeSessionId, requestId, decision });
    } catch (error) {
      this.#env.log(`[opencode] permission reply ${requestId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async respondApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.#pending.get(requestId);
    this.#pending.delete(requestId);
    if (decision === "acceptForSession" && pending) {
      const patterns = pending.save.length > 0 ? pending.save : pending.resources;
      this.#grants.push({ action: pending.action, patterns });
    }
    await this.#deps.api.replyPermission({ sessionId: this.nativeSessionId, requestId, decision: replyFor(decision) });
  }

  /**
   * `answers` is keyed by the form's field keys (`q0`, `q1`, … for the question tool); values
   * are option labels (or free text), mapped back to the option values the form expects.
   */
  async respondUserInput(requestId: string, answers: Record<string, unknown>): Promise<void> {
    const form = this.#forms.get(requestId);
    this.#forms.delete(requestId);
    const answer: Record<string, FormValue> = {};
    for (const field of form?.fields ?? []) {
      const raw = answers[field.key];
      const toValue = (label: string): string => field.options?.find((option) => option.label === label)?.value ?? label;
      if (Array.isArray(raw)) answer[field.key] = raw.filter((value): value is string => typeof value === "string").map(toValue);
      else if (typeof raw === "string") answer[field.key] = field.type === "multiselect" ? [toValue(raw)] : toValue(raw);
      else if (typeof raw === "number" || typeof raw === "boolean") answer[field.key] = raw;
    }
    if (form === undefined) for (const [key, value] of Object.entries(answers)) if (typeof value === "string") answer[key] = value;
    await this.#deps.api.replyForm({ sessionId: this.nativeSessionId, formId: requestId, answer });
  }

  /**
   * Everything a settings change touches can change in place in v2 (verified on 2.0.27):
   * `POST /session/:id/model`, `POST /session/:id/agent` and `PATCH /session/:id {permissions}`.
   * Any failure answers `reopen` so the server falls back to close + resume.
   */
  async reconfigure(settings: SessionSettings): Promise<ReconfigureResult> {
    try {
      const api = this.#deps.api;
      if (settings.model !== this.#settings.model && settings.model !== undefined && this.#deps.resolveModel) {
        const resolved = await this.#deps.resolveModel(settings.model);
        if (resolved.model) {
          await api.switchModel({ sessionId: this.nativeSessionId, model: resolved.model });
          this.#deps.model = resolved.model;
          if (resolved.contextWindow !== undefined) this.#deps.contextWindow = resolved.contextWindow;
        }
      }
      const agent = agentFor(this.#deps.agents, settings.interaction);
      if (agent !== this.#agent) await api.switchAgent({ sessionId: this.nativeSessionId, agent });
      this.#agent = agent;
      if (settings.mode !== this.#settings.mode || settings.interaction !== this.#settings.interaction) {
        await api.setPermissions({ sessionId: this.nativeSessionId, permissions: this.ruleset(settings) });
      }
      this.#settings = { ...settings };
      return "applied";
    } catch (error) {
      this.#env.log(`[opencode] in-place reconfigure failed, reopening: ${error instanceof Error ? error.message : String(error)}`);
      return "reopen";
    }
  }

  async interrupt(): Promise<void> {
    this.#normalizer?.markInterrupted();
    try {
      await this.#deps.api.interrupt({ sessionId: this.nativeSessionId });
    } catch (error) {
      this.#env.log(`[opencode] interrupt failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    this.#mailbox?.close();
    // MCP registrations are per location on a shared server; this thread's must go with it.
    for (const name of this.#deps.mcpNames ?? []) {
      try {
        await this.#deps.api.removeMcpServer({ directory: this.#options.cwd, name });
      } catch (error) {
        this.#env.log(`[opencode] could not remove MCP server ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.#deps.onClosed?.(this);
  }
}
