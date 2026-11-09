import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderKind } from "@tide/contracts";
import type { DriverRegistry } from "../provider/registry.ts";
import type { SettingsStore } from "../settings.ts";
import { RpcException } from "./router.ts";

/** What a tool-less one-shot prompt needs: the harnesses and the user's `textModel` choice. */
export interface OneShotDeps {
  registry: Pick<DriverRegistry, "get" | "has" | "statusAll">;
  settings: Pick<SettingsStore, "get">;
  /** scratch cwd parent for the harness; the OS temp dir when absent */
  tideHome?: string;
}

export interface OneShotRequest {
  system: string;
  prompt: string;
  maxOutputTokens: number;
  timeoutMs: number;
  /** scratch directory name under `tideHome` the harness runs in (default `one-shot`) */
  scratch?: string;
}

export interface OneShotResult {
  text: string;
  provider: ProviderKind;
  model?: string;
}

/** settings.textModel when installed, else the first harness that answers one-shot prompts. */
export async function pickProvider(deps: Pick<OneShotDeps, "registry" | "settings">): Promise<{ provider: ProviderKind; model?: string }> {
  const chosen = deps.settings.get().textModel;
  if (chosen !== undefined && deps.registry.has(chosen.provider)) {
    return { provider: chosen.provider, ...(chosen.model !== undefined ? { model: chosen.model } : {}) };
  }
  for (const status of await deps.registry.statusAll()) {
    if (status.caps.oneShot === true) return { provider: status.kind };
  }
  throw new RpcException("conflict", "no installed harness can answer one-shot prompts; pick one in settings");
}

/**
 * One tool-less prompt through `instance.complete` (titles, commit messages, PR text). Errors
 * surface as `RpcException`s (`conflict` when nothing can answer, `internal` otherwise).
 */
export async function completeOneShot(deps: OneShotDeps, request: OneShotRequest): Promise<OneShotResult> {
  const pick = await pickProvider(deps);
  try {
    const instance = await deps.registry.get(pick.provider);
    if (instance.complete === undefined) throw new RpcException("conflict", `${pick.provider} cannot answer one-shot prompts`);
    const cwd = join(deps.tideHome ?? tmpdir(), request.scratch ?? "one-shot");
    try {
      mkdirSync(cwd, { recursive: true });
    } catch {
      /* the driver reports a missing cwd itself */
    }
    const result = await instance.complete({
      system: request.system,
      prompt: request.prompt,
      ...(pick.model !== undefined ? { model: pick.model } : {}),
      maxOutputTokens: request.maxOutputTokens,
      timeoutMs: request.timeoutMs,
      signal: AbortSignal.timeout(request.timeoutMs),
      cwd,
    });
    const used = result.model ?? pick.model;
    return { text: result.text, provider: pick.provider, ...(used !== undefined ? { model: used } : {}) };
  } catch (err) {
    if (err instanceof RpcException) throw err;
    throw new RpcException("internal", (err as Error)?.message ?? String(err));
  }
}
