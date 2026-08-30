import type { DriverEnv, OpenSessionOptions, ProviderInstance, ProviderSession, ProviderStatus } from "@tide/contracts";
import { CodexSession } from "./session.ts";
import { shellQuote } from "./shell.ts";
import { buildStatus, detectBinary } from "./status.ts";
import type { CodexConfig } from "./types.ts";

const STATUS_TTL_MS = 60_000;

export class CodexInstance implements ProviderInstance {
  readonly kind = "codex" as const;

  #config: CodexConfig;
  #env: DriverEnv;
  #status: { at: number; value: ProviderStatus } | undefined;
  #statusInFlight: Promise<ProviderStatus> | undefined;
  #binaryPath: string | undefined;
  #sessions = new Set<CodexSession>();

  constructor(config: CodexConfig, env: DriverEnv) {
    this.#config = config;
    this.#env = env;
  }

  async status(): Promise<ProviderStatus> {
    const cached = this.#status;
    if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.value;
    this.#statusInFlight ??= buildStatus(this.#config, this.#env)
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
    if (this.#binaryPath === undefined) throw new Error("codex is not installed (not on PATH and no binaryPath configured)");
    const session = await CodexSession.open(this.#config, this.#env, options, this.#binaryPath);
    this.#sessions.add(session);
    return session;
  }

  /** Verified against `codex resume --help`: `codex resume [SESSION_ID]`, no flag. */
  terminalCommand(nativeSessionId: string, cwd: string): string {
    return `cd ${shellQuote(cwd)} && codex resume ${shellQuote(nativeSessionId)}`;
  }

  async dispose(): Promise<void> {
    const sessions = [...this.#sessions];
    this.#sessions.clear();
    await Promise.all(sessions.map((session) => session.close()));
  }
}
