import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { DriverEnv, ModelInfo, ProviderStatus } from "@tide/contracts";
import { AppServer, mergedEnv } from "./app-server.ts";
import type { CodexConfig } from "./types.ts";
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse.ts";
import type { Model } from "./generated/v2/Model.ts";
import type { ModelListResponse } from "./generated/v2/ModelListResponse.ts";

const run = promisify(execFile);

export const CODEX_CAPS = {
  planMode: true,
  subagents: true,
  mcp: true,
  images: true,
  resume: true,
  contextUsage: true,
  openInTerminal: true,
} as const;

export const LOGIN_HINT = "Run `codex login` in a terminal";
export const INSTALL_HINT = "Install Codex: run `npm i -g @openai/codex` in a terminal";

async function exec(file: string, args: string[], timeout = 10_000, env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const { stdout } = await run(file, args, { timeout, encoding: "utf8", ...(env ? { env } : {}) });
    return stdout;
  } catch {
    return undefined;
  }
}

export async function detectBinary(config: CodexConfig): Promise<string | undefined> {
  if (config.binaryPath && existsSync(config.binaryPath)) return config.binaryPath;
  // `config.env` also steers detection, so a pinned PATH finds the intended codex.
  const which = await exec("/usr/bin/env", ["which", "codex"], 5_000, mergedEnv(config));
  const resolved = which?.trim().split("\n")[0]?.trim();
  return resolved && resolved !== "" ? resolved : undefined;
}

export function parseVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(output.trim())?.[1];
}

/** `family` is the model slug's leading generation, e.g. `gpt-5.6-sol` -> `gpt-5.6`. */
export function toModelInfo(models: Model[], defaultModel: string | undefined): ModelInfo[] {
  return models
    .filter((model) => typeof model.id === "string" && model.id !== "" && model.hidden !== true)
    .map((model) => {
      const family = /^([a-z]+-[\d.]+)/i.exec(model.model ?? model.id)?.[1];
      const isDefault = defaultModel !== undefined ? model.id === defaultModel : model.isDefault === true;
      return {
        id: model.id,
        label: model.displayName ?? model.id,
        ...(family ? { family } : {}),
        default: isDefault,
      };
    });
}

interface Probe {
  loggedIn: boolean;
  models: ModelInfo[];
}

/**
 * Codex has no `--json` status command, so login state and the model catalogue both come
 * from a short-lived `codex app-server`: `account/read` returns the signed-in account (or
 * `null` with `requiresOpenaiAuth`) and `model/list` returns the catalogue, which is served
 * even when signed out — so a logged-out Tide still shows real model ids, never a table.
 */
export async function probe(binary: string, config: CodexConfig, env: DriverEnv): Promise<Probe> {
  let server: AppServer | undefined;
  try {
    server = await AppServer.start({
      binaryPath: binary,
      cwd: process.cwd(),
      env: mergedEnv(config),
      ...(config.spawnImpl ? { spawn: config.spawnImpl } : {}),
      log: () => undefined,
    });
    const account = await server.request<GetAccountResponse>("account/read", {});
    const models = await server.request<ModelListResponse>("model/list", {});
    return { loggedIn: account.account !== null, models: toModelInfo(models.data ?? [], config.defaultModel) };
  } catch (error) {
    env.log(`[codex] status probe failed: ${error instanceof Error ? error.message : String(error)}`);
    return { loggedIn: false, models: [] };
  } finally {
    server?.close();
  }
}

export async function buildStatus(config: CodexConfig, env: DriverEnv): Promise<ProviderStatus> {
  const binary = await detectBinary(config);
  if (!binary) {
    return { kind: "codex", installed: false, loggedIn: false, hint: INSTALL_HINT, models: [], caps: { ...CODEX_CAPS } };
  }
  const versionOutput = await exec(binary, ["--version"], 15_000);
  const version = versionOutput ? parseVersion(versionOutput) : undefined;
  const { loggedIn, models } = await probe(binary, config, env);
  return {
    kind: "codex",
    installed: true,
    loggedIn,
    ...(version ? { version } : {}),
    ...(loggedIn ? {} : { hint: LOGIN_HINT }),
    models,
    caps: { ...CODEX_CAPS },
  };
}
