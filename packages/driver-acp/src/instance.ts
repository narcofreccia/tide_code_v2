import type { DriverEnv, OpenSessionOptions, ProviderInstance, ProviderSession, ProviderStatus, SlashCommandInfo } from "@tide/contracts";
import { AcpSession } from "./session.ts";
import { agentEnv } from "./spawn.ts";
import { installHint, isNotFound, probeStatus, type AgentFacts } from "./status.ts";
import type { AcpConfig, AcpDeps } from "./types.ts";

const STATUS_TTL_MS = 60_000;
/** Defined by the sidecar build (`bun build --define TIDE_BUILD_VERSION=…`); undefined in dev and tests. */
declare const TIDE_BUILD_VERSION: string | undefined;
export const CLIENT_VERSION = typeof TIDE_BUILD_VERSION === "string" ? TIDE_BUILD_VERSION : "0.0.0-dev";

/**
 * One configured ACP agent (`acp:gemini`, `acp:copilot`, a manual command…). Each session is
 * its own agent process: ACP agents serve one client over stdio, and `session/load` lets a new
 * process resume an old session by id.
 */
export class AcpInstance implements ProviderInstance {
  readonly kind = "acp" as const;

  #config: AcpConfig;
  #env: DriverEnv;
  #deps: AcpDeps;
  #label: string;
  #facts: AgentFacts = {};
  #commands: SlashCommandInfo[] = [];
  #status: { at: number; value: ProviderStatus } | undefined;
  #statusInFlight: Promise<ProviderStatus> | undefined;
  #sessions = new Set<AcpSession>();

  constructor(config: AcpConfig, env: DriverEnv, deps: AcpDeps) {
    this.#config = config;
    this.#env = env;
    this.#deps = deps;
    this.#label = config.label ?? env.instance?.label ?? config.command;
  }

  async status(): Promise<ProviderStatus> {
    const cached = this.#status;
    if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.value;
    this.#statusInFlight ??= probeStatus(this.#config, this.#env, this.#deps, this.#label, this.#facts, CLIENT_VERSION)
      .then(({ status, facts }) => {
        this.#facts = facts;
        this.#status = { at: Date.now(), value: status };
        return status;
      })
      .finally(() => {
        this.#statusInFlight = undefined;
      });
    return this.#statusInFlight;
  }

  /** The latest `available_commands_update` any session of this agent received. */
  async listCommands(_options: { cwd: string }): Promise<SlashCommandInfo[]> {
    return this.#commands;
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
      onCommands: (commands) => {
        this.#commands = commands;
      },
    });
    try {
      await session.start(CLIENT_VERSION);
    } catch (error) {
      await session.close();
      if (isNotFound(error)) throw new Error(installHint(this.#label, this.#config.command));
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
    return {
      get nativeSessionId() {
        return session.nativeSessionId;
      },
      send: (input) => session.send(input),
      respondApproval: (requestId, decision) => session.respondApproval(requestId, decision),
      respondUserInput: (requestId, answers) => session.respondUserInput(requestId, answers),
      interrupt: () => session.interrupt(),
      reconfigure: (settings) => session.reconfigure(settings),
      close: async () => {
        this.#sessions.delete(session);
        await session.close();
      },
    };
  }

  #learn(facts: Partial<AgentFacts>): void {
    this.#facts = { ...this.#facts, ...facts };
    this.#status = undefined;
  }

  /** ACP has no portable "reopen in a terminal" command; each agent's CLI differs. */
  terminalCommand(_nativeSessionId: string, _cwd: string): string | undefined {
    return undefined;
  }

  async dispose(): Promise<void> {
    const sessions = [...this.#sessions];
    this.#sessions.clear();
    await Promise.all(sessions.map((session) => session.close()));
  }
}
