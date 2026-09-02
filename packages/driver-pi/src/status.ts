import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { DriverEnv, ModelInfo, ProviderStatus } from "@tide/contracts";
import { detectLocalModels, readModelsJson } from "./local-models.ts";
import { PiRpc } from "./rpc.ts";
import type { PiConfig, PiDeps, PiModel } from "./types.ts";

const run = promisify(execFile);

export const PI_CAPS = {
  // plan mode is emulated by tide-bridge (system prompt + tide_propose_plan); pi has none native
  planMode: true,
  // pi has no sub-agent concept, and no MCP wiring in P4 (P5 adds it through an extension)
  subagents: false,
  mcp: false,
  // `prompt` accepts `images: [{type:"image", data, mimeType}]` (docs/rpc.md § prompt)
  images: true,
  // sessions are `.jsonl` files; `--session <path|id>` reopens one
  resume: true,
  // `get_session_stats` returns `contextUsage {tokens, contextWindow, percent}`
  contextUsage: true,
  openInTerminal: true,
} as const;

/**
 * The web parses the FIRST backticked span as a runnable command, so it has to come first.
 * pi has no non-interactive login subcommand (`pi auth` only prints existing credentials);
 * signing in happens with `/login` inside the TUI, so the runnable command is plain `pi`.
 */
export const LOGIN_HINT = "Run `pi` once and sign in with /login, or set ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY";
/**
 * pi has no non-interactive login subcommand (`pi auth` only prints existing credentials),
 * so the runnable command is plain `pi`; the user types `/login` once it is up, which the
 * hint spells out.
 */
export const LOGIN_COMMAND = "pi";
export const INSTALL_HINT = "Install pi: `npm i -g @earendil-works/pi-coding-agent`";

const API_KEY_ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"];

async function exec(file: string, args: string[], timeout = 10_000): Promise<string | undefined> {
  try {
    const { stdout } = await run(file, args, { timeout, encoding: "utf8" });
    return stdout;
  } catch {
    return undefined;
  }
}

/** Walks up from this file looking for a workspace `node_modules/.bin/pi`. */
export function workspaceBinary(from = fileURLToPath(import.meta.url)): string | undefined {
  let dir = dirname(from);
  for (;;) {
    const candidate = join(dir, "node_modules", ".bin", "pi");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** config.binaryPath → PATH → the workspace's own `@earendil-works/pi-coding-agent`. */
export async function detectBinary(config: PiConfig): Promise<string | undefined> {
  if (config.binaryPath && existsSync(config.binaryPath)) return config.binaryPath;
  const which = await exec("/usr/bin/env", ["which", "pi"], 5_000);
  const resolved = which?.trim().split("\n")[0]?.trim();
  if (resolved && resolved !== "" && existsSync(resolved)) return resolved;
  return workspaceBinary();
}

export function parseVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(output.trim())?.[1];
}

function authFileHasEntry(home: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(home, ".pi", "agent", "auth.json"), "utf8"));
    if (Array.isArray(parsed)) return parsed.length > 0;
    if (typeof parsed === "object" && parsed !== null) return Object.keys(parsed).length > 0;
    return false;
  } catch {
    return false;
  }
}

/**
 * pi is usable when it has any credential: an entry in its own `auth.json`, a provider API key
 * in the environment, or a custom provider in `models.json` (which is how a local Ollama /
 * LM Studio setup shows up). A false positive only costs a clearer error on the first turn.
 */
export function detectLogin(env: NodeJS.ProcessEnv = process.env, home = homedir()): boolean {
  if (authFileHasEntry(home)) return true;
  if (API_KEY_ENV.some((key) => (env[key] ?? "") !== "")) return true;
  const models = readModelsJson(join(home, ".pi", "agent", "models.json"));
  return Object.keys(models?.providers ?? {}).length > 0;
}

function toModelInfo(models: PiModel[], defaultModel: string | undefined): ModelInfo[] {
  return models
    .filter((model) => typeof model.id === "string" && model.id !== "")
    .map((model) => {
      const id = model.provider ? `${model.provider}/${model.id}` : model.id;
      return {
        id,
        label: model.name ?? model.id,
        ...(model.provider ? { family: model.provider } : {}),
        ...(defaultModel !== undefined ? { default: id === defaultModel || model.id === defaultModel } : {}),
      };
    });
}

/**
 * Asks pi for its own model list over a short-lived `pi --mode rpc --no-session` process
 * (`get_available_models`, docs/rpc.md § Model). Falls back to parsing `models.json`, which is
 * all a machine with only custom providers has. Never a hardcoded table (CLAUDE.md §1a).
 */
export async function listModels(binary: string, config: PiConfig, deps: PiDeps, env: DriverEnv): Promise<ModelInfo[]> {
  const child = deps.spawn(binary, ["--mode", "rpc", "--no-session"], {
    cwd: process.cwd(),
    env: { ...process.env, ...config.env },
  });
  const rpc = new PiRpc(child, { onLine: () => undefined, log: (message) => env.log(message) });
  try {
    const data = await rpc.data<{ models?: PiModel[] }>({ type: "get_available_models" });
    const models = toModelInfo(data?.models ?? [], config.defaultModel);
    if (models.length > 0) return models;
  } catch (error) {
    env.log(`[pi] get_available_models failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rpc.close();
  }
  return modelsFromConfigFile(config.defaultModel);
}

export function modelsFromConfigFile(defaultModel: string | undefined, home = homedir()): ModelInfo[] {
  const providers = readModelsJson(join(home, ".pi", "agent", "models.json"))?.providers ?? {};
  return Object.entries(providers).flatMap(([provider, spec]) =>
    (spec.models ?? []).map((model) => ({
      id: `${provider}/${model.id}`,
      label: `${model.id} (${provider})`,
      family: provider,
      ...(defaultModel !== undefined ? { default: `${provider}/${model.id}` === defaultModel } : {}),
    })),
  );
}

/** Merges pi's own catalogue with live local servers, without duplicating ids. */
export function mergeModels(fromPi: ModelInfo[], local: ModelInfo[]): ModelInfo[] {
  const seen = new Set(fromPi.map((model) => model.id));
  return [...fromPi, ...local.filter((model) => !seen.has(model.id))];
}

export async function buildStatus(config: PiConfig, env: DriverEnv, deps: PiDeps): Promise<ProviderStatus> {
  const binary = await detectBinary(config);
  const local = await detectLocalModels(deps.fetch);
  if (!binary) {
    return { kind: "pi", installed: false, loggedIn: false, hint: INSTALL_HINT, models: local, caps: { ...PI_CAPS } };
  }
  const versionOutput = await exec(binary, ["--version"], 15_000);
  const version = versionOutput ? parseVersion(versionOutput) : undefined;
  const loggedIn = detectLogin(process.env) || local.length > 0;
  const fromPi = loggedIn ? await listModels(binary, config, deps, env) : [];

  return {
    kind: "pi",
    installed: true,
    loggedIn,
    ...(version ? { version } : {}),
    ...(loggedIn ? {} : { hint: LOGIN_HINT, loginCommand: LOGIN_COMMAND }),
    models: mergeModels(fromPi, local),
    caps: { ...PI_CAPS },
  };
}
