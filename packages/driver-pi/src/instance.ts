import type { CompletionRequest, SlashCommandInfo, CompletionResult, DriverEnv, OpenSessionOptions, ProviderInstance, ProviderSession, ProviderStatus } from "@tide/contracts";
import { runComplete } from "./complete.ts";
import { resolveBridgePath } from "./bridge-path.ts";
import { listCommands } from "./commands.ts";
import { PiSession } from "./session.ts";
import { buildSpawn } from "./spawn.ts";
import { shellQuote } from "./shell.ts";
import { buildStatus, detectBinary, INSTALL_HINT } from "./status.ts";
import type { PiConfig, PiDeps } from "./types.ts";

const STATUS_TTL_MS = 60_000;

export class PiInstance implements ProviderInstance {
  readonly kind = "pi" as const;

  #config: PiConfig;
  #env: DriverEnv;
  #deps: PiDeps;
  #status: { at: number; value: ProviderStatus } | undefined;
  #statusInFlight: Promise<ProviderStatus> | undefined;
  #binaryPath: string | undefined;
  #sessions = new Set<PiSession>();

  constructor(config: PiConfig, env: DriverEnv, deps: PiDeps) {
    // R8: a second pi account is another HOME (pi keeps ~/.pi/agent there); instance env wins over config env
    const instance = env.instance;
    this.#config = instance ? { ...config, env: { ...config.env, ...instance.env, ...(instance.home ? { HOME: instance.home } : {}) } } : config;
    this.#env = env;
    this.#deps = deps;
  }

  async status(): Promise<ProviderStatus> {
    const cached = this.#status;
    if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.value;
    this.#statusInFlight ??= buildStatus(this.#config, this.#env, this.#deps)
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
    this.#binaryPath ??= (await detectBinary(this.#config, this.#deps.probe, this.#env.log))?.path;
    const binary = this.#binaryPath;
    if (!binary) throw new Error(INSTALL_HINT);
    const bridgePath = this.#deps.bridgePath ?? resolveBridgePath();
    if (!bridgePath) this.#env.log("[pi] tide-bridge not found; approvals, plan mode, live reconfigure and Tide MCP are unavailable");
    const { args, env } = buildSpawn(options, this.#config, bridgePath);
    this.#env.log(`[pi] ${binary} ${args.join(" ")}`);
    const child = this.#deps.spawn(binary, args, { cwd: options.cwd, env });
    const session = new PiSession(child, this.#env, options);
    await session.prime();
    this.#sessions.add(session);
    return session;
  }

  /** R8: `get_commands` on a short-lived rpc process in `cwd` (prompt templates and skills are cwd-scoped). */
  async listCommands({ cwd }: { cwd: string }): Promise<SlashCommandInfo[]> {
    this.#binaryPath ??= (await detectBinary(this.#config, this.#deps.probe, this.#env.log))?.path;
    if (!this.#binaryPath) return [];
    return listCommands(this.#binaryPath, cwd, this.#config, this.#deps, this.#env);
  }

  /** One-shot, tools-off `pi -p` call (judge fallback); never a user thread. */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.#binaryPath ??= (await detectBinary(this.#config, this.#deps.probe, this.#env.log))?.path;
    if (!this.#binaryPath) throw new Error(INSTALL_HINT);
    return runComplete(this.#binaryPath, request, this.#config, this.#deps.spawn);
  }

  /** `pi --session <path|id>` reopens an existing session file (see `pi --help`). */
  terminalCommand(nativeSessionId: string, cwd: string): string {
    return `cd ${shellQuote(cwd)} && pi --session ${shellQuote(nativeSessionId)}`;
  }

  async dispose(): Promise<void> {
    const sessions = [...this.#sessions];
    this.#sessions.clear();
    await Promise.all(sessions.map((session) => session.close()));
  }
}
