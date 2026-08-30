import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DriverEnv, ModelInfo, ProviderStatus } from "@tide/contracts";
import type { ClaudeConfig, QueryFn, SdkModelInfo } from "./types.ts";

const run = promisify(execFile);

export const CLAUDE_CAPS = {
  planMode: true,
  subagents: true,
  mcp: true,
  images: true,
  resume: true,
  contextUsage: true,
  openInTerminal: true,
} as const;

export const LOGIN_HINT = "Run `claude auth login` in a terminal";

/**
 * Fallback only. Real ids come from the CLI (`supportedModels()`); this list is aliases —
 * never dated model ids — so it cannot go stale into a wrong answer (CLAUDE.md §1a).
 */
const FALLBACK_MODELS: ModelInfo[] = [
  { id: "opus", label: "Opus (fallback list)", family: "opus" },
  { id: "sonnet", label: "Sonnet (fallback list)", family: "sonnet", default: true },
  { id: "haiku", label: "Haiku (fallback list)", family: "haiku" },
];

async function exec(file: string, args: string[], timeout = 10_000): Promise<string | undefined> {
  try {
    const { stdout } = await run(file, args, { timeout, encoding: "utf8" });
    return stdout;
  } catch {
    return undefined;
  }
}

export async function detectBinary(config: ClaudeConfig): Promise<string | undefined> {
  if (config.binaryPath && existsSync(config.binaryPath)) return config.binaryPath;
  const local = join(homedir(), ".local", "bin", "claude");
  if (existsSync(local)) return local;
  const which = await exec("/usr/bin/env", ["which", "claude"], 5_000);
  const resolved = which?.trim().split("\n")[0]?.trim();
  return resolved && resolved !== "" ? resolved : undefined;
}

export function parseVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(output.trim())?.[1];
}

/**
 * Login detection, in order of trust:
 *  1. `claude auth status` — present in Claude Code 2.1.x, prints JSON with `loggedIn`.
 *  2. otherwise, presence of `~/.claude/.credentials.json` or `~/.claude.json`.
 * The file check is a weak signal on macOS, where the OAuth token lives in the Keychain and
 * `.credentials.json` never exists — so `~/.claude.json` (written on first run) is accepted
 * too. A false positive only costs a clearer error on the first turn; a false negative would
 * block a working install, which is worse.
 */
export async function detectLogin(binary: string): Promise<boolean> {
  const output = await exec(binary, ["auth", "status"], 15_000);
  if (output !== undefined) {
    try {
      const parsed: unknown = JSON.parse(output);
      if (typeof parsed === "object" && parsed !== null && "loggedIn" in parsed) {
        return (parsed as { loggedIn?: unknown }).loggedIn === true;
      }
    } catch {
      if (/logged\s*in|authenticated/i.test(output) && !/not\s+logged|no\s+credentials/i.test(output)) return true;
    }
  }
  return existsSync(join(homedir(), ".claude", ".credentials.json")) || existsSync(join(homedir(), ".claude.json"));
}

function toModelInfo(models: SdkModelInfo[], defaultModel: string | undefined): ModelInfo[] {
  return models
    .filter((model) => typeof model.value === "string" && model.value !== "")
    .map((model) => {
      const family = (model.resolvedModel ?? model.value).match(/opus|sonnet|haiku|fable/i)?.[0]?.toLowerCase();
      return {
        id: model.value,
        label: model.displayName ?? model.value,
        ...(family ? { family } : {}),
        ...(defaultModel !== undefined ? { default: model.value === defaultModel } : { default: model.value === "default" }),
      };
    });
}

/**
 * Asks the CLI for its own model list over the SDK control channel (an idle streaming-input
 * session that is aborted right after). ~1s; the caller caches it.
 */
export async function listModels(queryFn: QueryFn, options: Record<string, unknown>, defaultModel: string | undefined, env: DriverEnv): Promise<ModelInfo[]> {
  const abort = new AbortController();
  try {
    const idle = (async function* () {
      await new Promise((resolve) => setTimeout(resolve, 30_000).unref?.());
    })();
    const query = queryFn({ prompt: idle, options: { ...options, abortController: abort } });
    if (!query.supportedModels) return FALLBACK_MODELS;
    const models = await query.supportedModels();
    const mapped = toModelInfo(models, defaultModel);
    return mapped.length > 0 ? mapped : FALLBACK_MODELS;
  } catch (error) {
    env.log(`[claude] supportedModels failed, using the fallback alias list: ${error instanceof Error ? error.message : String(error)}`);
    return FALLBACK_MODELS;
  } finally {
    abort.abort();
  }
}

export async function buildStatus(config: ClaudeConfig, env: DriverEnv, queryFn: QueryFn): Promise<ProviderStatus> {
  const binary = await detectBinary(config);
  if (!binary) {
    return {
      kind: "claude",
      installed: false,
      loggedIn: false,
      hint: "Install Claude Code: https://claude.com/claude-code",
      models: FALLBACK_MODELS,
      caps: { ...CLAUDE_CAPS },
    };
  }
  const versionOutput = await exec(binary, ["--version"], 15_000);
  const version = versionOutput ? parseVersion(versionOutput) : undefined;
  const loggedIn = await detectLogin(binary);
  const models = loggedIn
    ? await listModels(queryFn, { cwd: process.cwd(), pathToClaudeCodeExecutable: binary, env: { ...process.env, ...config.env } }, config.defaultModel, env)
    : FALLBACK_MODELS;

  return {
    kind: "claude",
    installed: true,
    loggedIn,
    ...(version ? { version } : {}),
    ...(loggedIn ? {} : { hint: LOGIN_HINT }),
    models,
    caps: { ...CLAUDE_CAPS },
  };
}
