import type { RunListen, RunReadiness, RunService } from "@tide/contracts";
import { joinRel, type RepoFs } from "./fsFacade.ts";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** Shared state of one scan: every manifest read is recorded (for the hash and the model prompt). */
export interface ScanCtx {
  fs: RepoFs;
  repoKey: string;
  services: RunService[];
  /** added only when the scan found nothing else (generic `dev` script, Makefile) */
  fallbacks: RunService[];
  warnings: string[];
  /** rel → text of every manifest read; `secret` ones feed the hash but are never handed out */
  read(rel: string, opts?: { secret?: boolean; maxBytes?: number }): Promise<string | undefined>;
  readonly manifests: Map<string, string>;
  readonly secrets: Set<string>;
}

export function createCtx(fs: RepoFs, repoKey: string): ScanCtx {
  const manifests = new Map<string, string>();
  const secrets = new Set<string>();
  return {
    fs,
    repoKey,
    services: [],
    fallbacks: [],
    warnings: [],
    manifests,
    secrets,
    async read(rel, opts = {}) {
      if (manifests.has(rel)) return manifests.get(rel);
      const text = await fs.readText(rel, opts.maxBytes ?? 512 * 1024);
      if (text !== undefined) {
        manifests.set(rel, text);
        if (opts.secret === true) secrets.add(rel);
      }
      return text;
    },
  };
}

export const READY_VITE: RunReadiness = { kind: "log", pattern: "(Local:|ready in)" };
export const READY_TAURI: RunReadiness = { kind: "log", pattern: "(Local:|ready in|Finished dev)" };
export const READY_EXPO: RunReadiness = { kind: "log", pattern: "(Metro waiting|Waiting on http)" };
export const READY_UVICORN: RunReadiness = { kind: "log", pattern: "Uvicorn running on" };

export const viteListen = (port: number): RunListen => ({ name: "http", port, how: "flag", flag: "--port", flagStyle: "space", strictFlag: "--strictPort" });

/** Root-relative dir of a service ("" for the repo root). */
export const serviceDir = (s: RunService): string => (s.cwd === undefined || s.cwd === "." ? "" : s.cwd);

/** Adds a service; an id taken by another dir gets `-<dir>`; a duplicate after that is dropped. */
export function addService(ctx: ScanCtx, service: RunService): RunService | undefined {
  const taken = (id: string): boolean => ctx.services.some((s) => s.id === id);
  let s = service;
  if (taken(s.id)) {
    const dir = serviceDir(s);
    const suffix = (dir.split("/").pop() ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (suffix === "") return undefined;
    s = { ...s, id: `${s.id}-${suffix}` };
    if (taken(s.id)) return undefined;
  }
  ctx.services.push(s);
  return s;
}

export async function detectPm(ctx: ScanCtx, dir: string): Promise<PackageManager> {
  for (const d of dir === "" ? [""] : [dir, ""]) {
    if (await ctx.fs.exists(joinRel(d, "pnpm-lock.yaml"))) return "pnpm";
    if (await ctx.fs.exists(joinRel(d, "yarn.lock"))) return "yarn";
    if ((await ctx.fs.exists(joinRel(d, "bun.lockb"))) || (await ctx.fs.exists(joinRel(d, "bun.lock")))) return "bun";
    if (await ctx.fs.exists(joinRel(d, "package-lock.json"))) return "npm";
  }
  return "npm";
}

/** `npm run dev`, `pnpm dev`, …; extra args need `--` only with npm. */
export function runScript(pm: PackageManager, script: string, args?: string): string {
  const base = pm === "npm" ? `npm run ${script}` : pm === "bun" ? `bun run ${script}` : `${pm} ${script}`;
  if (args === undefined || args === "") return base;
  return pm === "npm" ? `${base} -- ${args}` : `${base} ${args}`;
}

/**
 * The `--port N` / `--port=N` a command already carries. The run planner (S2) strips this match
 * before appending its own `--port`, so a flag is never passed twice.
 */
export function existingPortFlag(command: string): { port: number; match: string } | undefined {
  const m = /(?:^|\s)(--port(?:\s+|=)(\d{1,5}))(?=\s|$)/.exec(command);
  if (!m) return undefined;
  return { port: Number(m[2]), match: m[1] as string };
}
