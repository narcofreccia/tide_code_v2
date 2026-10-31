import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { RunProfile, RunService } from "@tide/contracts";
import { detectEnv, detectOverrides } from "./detectEnv.ts";
import { detectNode } from "./detectNode.ts";
import { detectCompose, detectMakefile, detectProcfile, detectPython } from "./detectOther.ts";
import type { RepoFs } from "./fsFacade.ts";
import { createCtx } from "./scanCtx.ts";

export { existingPortFlag } from "./scanCtx.ts";
export { nodeRepoFs, type RepoFs } from "./fsFacade.ts";

/** `Tide Backend!` → `tide-backend-`… trimmed: lowercase, `[^a-z0-9_-]` → `-`, leading non-alphanumerics dropped. */
export function defaultRepoKey(repoPath: string): string {
  const key = basename(repoPath.replace(/[\\/]+$/, "")).toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^[^a-z0-9]+/, "");
  return key === "" ? "repo" : key;
}

const KIND_ORDER: Record<string, number> = { tauri: 0, vite: 1, expo: 2, uvicorn: 3, node: 4, worker: 5, other: 6 };
const rank = (s: RunService): number => KIND_ORDER[s.kind ?? "other"] ?? 6;

export function hashManifests(manifests: Map<string, string>): string {
  const h = createHash("sha1");
  for (const rel of [...manifests.keys()].sort()) h.update(`${rel}\0${manifests.get(rel) as string}\0`);
  return h.digest("hex");
}

export interface ScanResult {
  profile: RunProfile;
  /** manifest texts read (package.json, configs, `.env.example`); real `.env` files are hashed, never returned */
  manifests: Record<string, string>;
  /** every file read, secrets included (cache stamps) */
  read: string[];
}

/**
 * Detects a repo's dev services from its manifests. Pure over `fs`; never writes.
 * `grep: false` skips the source walk for override-env warnings (the hash does not depend on it).
 */
export async function scanRepo(fs: RepoFs, opts: { repoKey: string; grep?: boolean; now?: number }): Promise<ScanResult> {
  const ctx = createCtx(fs, opts.repoKey);
  await detectNode(ctx);
  await detectPython(ctx);
  await detectProcfile(ctx);
  await detectCompose(ctx);
  await detectMakefile(ctx);
  if (ctx.services.length === 0 && ctx.fallbacks.length > 0) ctx.services.push(ctx.fallbacks[0] as RunService);
  // stable sort: the main service of the repo comes first (the one `.env` URLs attach to)
  ctx.services = ctx.services.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map(({ s }) => s);
  await detectEnv(ctx);
  const warnings = [...ctx.warnings];
  if (opts.grep !== false) warnings.push(...(await detectOverrides(fs)));
  if (ctx.services.length === 0) warnings.push("no dev service detected; edit .tide/run.json or ask the model");
  const manifests: Record<string, string> = {};
  for (const [rel, text] of ctx.manifests) if (!ctx.secrets.has(rel)) manifests[rel] = text;
  return {
    profile: {
      version: 1,
      repoKey: opts.repoKey,
      services: ctx.services,
      source: "manifest",
      manifestHash: hashManifests(ctx.manifests),
      generatedAt: opts.now ?? Date.now(),
      warnings,
    },
    manifests,
    read: [...ctx.manifests.keys()],
  };
}
