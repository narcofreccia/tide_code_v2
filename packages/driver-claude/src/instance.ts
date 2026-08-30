import type { DriverEnv, OpenSessionOptions, ProviderInstance, ProviderSession, ProviderStatus } from "@tide/contracts";
import { ClaudeSession } from "./session.ts";
import { shellQuote } from "./shell.ts";
import { buildStatus, detectBinary } from "./status.ts";
import type { ClaudeConfig, QueryFn } from "./types.ts";

const STATUS_TTL_MS = 60_000;

export class ClaudeInstance implements ProviderInstance {
  readonly kind = "claude" as const;

  #config: ClaudeConfig;
  #env: DriverEnv;
  #queryFn: QueryFn;
  #status: { at: number; value: ProviderStatus } | undefined;
  #statusInFlight: Promise<ProviderStatus> | undefined;
  #binaryPath: string | undefined;
  #sessions = new Set<ClaudeSession>();

  constructor(config: ClaudeConfig, env: DriverEnv, queryFn: QueryFn) {
    this.#config = config;
    this.#env = env;
    this.#queryFn = queryFn;
  }

  async status(): Promise<ProviderStatus> {
    const cached = this.#status;
    if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.value;
    this.#statusInFlight ??= buildStatus(this.#config, this.#env, this.#queryFn)
      .then((value) => {
        this.#status = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.#statusInFlight = undefined;
      });
    return this.#statusInFlight;
  }

  async openSession(options: OpenSessionOptions): Promise<ProviderSession> {
    this.#binaryPath ??= await detectBinary(this.#config);
    const session = new ClaudeSession(this.#config, this.#env, options, this.#queryFn, this.#binaryPath);
    this.#sessions.add(session);
    return session;
  }

  terminalCommand(nativeSessionId: string, cwd: string): string {
    return `cd ${shellQuote(cwd)} && claude --resume ${shellQuote(nativeSessionId)}`;
  }

  async dispose(): Promise<void> {
    const sessions = [...this.#sessions];
    this.#sessions.clear();
    await Promise.all(sessions.map((session) => session.close()));
  }
}
