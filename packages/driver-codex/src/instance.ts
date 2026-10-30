import type { CompletionRequest, SlashCommandInfo, CompletionResult, DriverEnv, OpenSessionOptions, ProviderInstance, ProviderSession, ProviderStatus } from "@tide/contracts";
import { CompletionService } from "./complete.ts";
import { CodexSession } from "./session.ts";
import { shellQuote } from "./shell.ts";
import { withInstance } from "./instance-config.ts";
import { fetchSkills } from "./skills.ts";
import { AppServer, mergedEnv } from "./app-server.ts";
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
  #completions: CompletionService | undefined;

  constructor(config: CodexConfig, env: DriverEnv) {
    this.#config = withInstance(config, env);
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

  /**
   * R8: skills only — the app-server has `skills/list` but no custom-prompt listing. Runs on a
   * short-lived app-server rooted at `cwd` (skills are per-cwd).
   */
  async listCommands({ cwd }: { cwd: string }): Promise<SlashCommandInfo[]> {
    this.#binaryPath ??= await detectBinary(this.#config);
    if (this.#binaryPath === undefined) return [];
    let server: AppServer | undefined;
    try {
      server = await AppServer.start({
        binaryPath: this.#binaryPath,
        cwd,
        env: mergedEnv(this.#config),
        ...(this.#config.spawnImpl ? { spawn: this.#config.spawnImpl } : {}),
        log: () => undefined,
      });
      return (await fetchSkills(server, cwd)).map((skill) => skill.info);
    } catch (error) {
      this.#env.log(`[codex] skills/list failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    } finally {
      server?.close();
    }
  }

  /** R6: one-shot tools-off classifier call on a shared, idle-reaped app-server. */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.#completions ??= new CompletionService(this.#config, this.#env, async () => {
      this.#binaryPath ??= await detectBinary(this.#config);
      if (this.#binaryPath === undefined) throw new Error("codex is not installed (not on PATH and no binaryPath configured)");
      return this.#binaryPath;
    });
    return this.#completions.complete(request);
  }

  /** Verified against `codex resume --help`: `codex resume [SESSION_ID]`, no flag. */
  terminalCommand(nativeSessionId: string, cwd: string): string {
    return `cd ${shellQuote(cwd)} && codex resume ${shellQuote(nativeSessionId)}`;
  }

  async dispose(): Promise<void> {
    this.#completions?.dispose();
    const sessions = [...this.#sessions];
    this.#sessions.clear();
    await Promise.all(sessions.map((session) => session.close()));
  }
}
