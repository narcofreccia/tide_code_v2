import type { CompletionRequest, CompletionResult, DriverEnv, OpenSessionOptions, ProviderInstance, ProviderKind, ProviderSession, ProviderStatus, SlashCommandInfo } from "@tide/contracts";
import { readCommandsCache, writeCommandsCache } from "./commands-cache.ts";
import { withProfileQuirks } from "./profiles.ts";
import { AcpSession } from "./session.ts";
import { agentEnv } from "./spawn.ts";
import { installHint, isNotFound, probeStatus, type AgentFacts } from "./status.ts";
import { GENERIC_FLAVOR, type AcpConfig, type AcpDeps, type AcpFlavor } from "./types.ts";

const STATUS_TTL_MS = 60_000;
/** Defined by the sidecar build (`bun build --define TIDE_BUILD_VERSION=…`); undefined in dev and tests. */
declare const TIDE_BUILD_VERSION: string | undefined;
export const CLIENT_VERSION = typeof TIDE_BUILD_VERSION === "string" ? TIDE_BUILD_VERSION : "0.0.0-dev";

/**
 * One configured ACP agent (`acp:gemini`, `acp:copilot`, a manual command…). Each session is
 * its own agent process: ACP agents serve one client over stdio, and `session/load` lets a new
 * process resume an old session by id. A built-in harness on this driver (Antigravity) passes
 * its `flavor`: kind, login command, install hint, version floor.
 */
export class AcpInstance implements ProviderInstance {
  readonly kind: ProviderKind;
  readonly complete?: (request: CompletionRequest) => Promise<CompletionResult>;

  #flavor: AcpFlavor;
  #config: AcpConfig;
  #env: DriverEnv;
  #deps: AcpDeps;
  #label: string;
  #facts: AgentFacts = {};
  #commands: SlashCommandInfo[] = [];
  #status: { at: number; value: ProviderStatus } | undefined;
  #statusInFlight: Promise<ProviderStatus> | undefined;
  #sessions = new Set<AcpSession>();

  constructor(config: AcpConfig, env: DriverEnv, deps: AcpDeps, flavor: AcpFlavor = GENERIC_FLAVOR) {
    this.kind = flavor.kind;
    this.#flavor = flavor;
    this.#config = withProfileQuirks(config);
    this.#env = env;
    this.#deps = deps;
    this.#label = config.label ?? env.instance?.label ?? config.command;
    if (flavor.complete) {
      const run = flavor.complete;
      this.complete = (request) => run(this.#config, this.#env, request, this.#deps);
    }
  }

  async status(refresh = false): Promise<ProviderStatus> {
    const cached = this.#status;
    if (!refresh && cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.value;
    this.#statusInFlight ??= probeStatus({
      config: this.#config,
      env: this.#env,
      deps: this.#deps,
      label: this.#label,
      facts: this.#facts,
      version: CLIENT_VERSION,
      flavor: this.#flavor,
      refresh,
      onCommands: (commands) => this.#setCommands(commands),
    })
      .then(({ status, facts }) => {
        // a live session may have learned context usage while the probe ran
        const learned = this.#facts.contextUsage === true && facts.contextUsage !== true;
        this.#facts = learned ? { ...facts, contextUsage: true } : facts;
        const value = learned ? { ...status, caps: { ...status.caps, contextUsage: true } } : status;
        this.#status = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.#statusInFlight = undefined;
      });
    return this.#statusInFlight;
  }

  /**
   * The latest `available_commands_update` any session (or the status probe) of this agent
   * received; before one arrives in this run, the list cached on disk by an earlier one.
   */
  async listCommands(_options: { cwd: string }): Promise<SlashCommandInfo[]> {
    if (this.#commands.length === 0) {
      const cached = await readCommandsCache(this.#env);
      if (this.#commands.length === 0) this.#commands = cached;
    }
    return this.#commands;
  }

  #setCommands(commands: SlashCommandInfo[]): void {
    this.#commands = commands;
    writeCommandsCache(this.#env, commands);
  }

  async openSession(options: OpenSessionOptions): Promise<ProviderSession> {
    const args = this.#config.args ?? [];
    this.#env.log(`[acp:${this.#label}] ${this.#config.command} ${args.join(" ")}`);
    const child = this.#deps.spawn(this.#config.command, args, { cwd: options.cwd, env: agentEnv(this.#config, this.#env, options.env) });
    const session = new AcpSession(child, options, {
      config: this.#config,
      env: this.#env,
      label: this.#label,
      ...(this.#deps.timers ? { timers: this.#deps.timers } : {}),
      ...(this.#deps.initializeTimeoutMs !== undefined ? { initializeTimeoutMs: this.#deps.initializeTimeoutMs } : {}),
      onInitialized: (init) => {
        this.#facts = { ...this.#facts, init };
      },
      onAuthRequired: (hint) => this.#learn({ authHint: hint }),
      onCommands: (commands) => this.#setCommands(commands),
      onContextUsage: () => {
        if (this.#facts.contextUsage !== true) this.#learn({ contextUsage: true });
      },
    });
    try {
      await session.start(CLIENT_VERSION);
    } catch (error) {
      await session.close();
      if (isNotFound(error)) throw new Error((this.#flavor.notInstalledHint ?? installHint)(this.#label, this.#config.command));
      throw error; // AcpAuthRequiredError carries the agent's login hint
    }
    const settings = session.settings;
    if (settings) {
      // a session opened, so the agent is logged in; refresh what status() reports
      const { authHint: _cleared, ...rest } = this.#facts;
      this.#facts = {
        ...rest,
        models: settings.modelList.length > 0 ? settings.modelList : (this.#facts.models ?? []),
        planMode: settings.planSupported,
        effort: settings.efforts !== undefined,
      };
      this.#status = undefined;
    }
    this.#sessions.add(session);
    const handle: ProviderSession = {
      get nativeSessionId() {
        return session.nativeSessionId;
      },
      get resumeFailed() {
        return session.resumeFailed;
      },
      send: (input) => session.send(input),
      respondApproval: (requestId, decision) => session.respondApproval(requestId, decision),
      respondUserInput: (requestId, answers) => session.respondUserInput(requestId, answers),
      interrupt: () => session.interrupt(),
      reconfigure: (settings) => session.reconfigure(settings),
      ...(this.#config.quirks?.steerByPrompt === true ? { steer: (input, target) => session.steer(input, target) } : {}),
      ...(this.#config.quirks?.harnessTurns === true
        ? {
            onHarnessTurn: (listener) => session.onHarnessTurn(listener),
            onIdleActivity: (listener) => session.onIdleActivity(listener),
            hasBackgroundWork: () => session.hasBackgroundWork(),
          }
        : {}),
      close: async () => {
        this.#sessions.delete(session);
        await session.close();
      },
    };
    return handle;
  }

  #learn(facts: Partial<AgentFacts>): void {
    this.#facts = { ...this.#facts, ...facts };
    this.#status = undefined;
  }

  /** ACP has no portable "reopen in a terminal" command; only a flavor that knows its CLI has one. */
  terminalCommand(nativeSessionId: string, cwd: string): string | undefined {
    return this.#flavor.terminalCommand?.(this.#config.command, nativeSessionId, cwd);
  }

  async dispose(): Promise<void> {
    const sessions = [...this.#sessions];
    this.#sessions.clear();
    await Promise.all(sessions.map((session) => session.close()));
  }
}
