import { mkdirSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import { RunProfile, RunService, type ReadModel, type RunRepo } from "@tide/contracts";
import { completeJson } from "../provider/json.ts";
import { pickProvider, type TitleDeps } from "../rpc/titles.ts";
import { ensureExcluded } from "../workspace/attachments.ts";
import { nodeRepoFs, type RepoFs } from "./fsFacade.ts";
import { MODEL_SYSTEM, buildModelPrompt } from "./modelPrompt.ts";
import { parseQuickstart } from "./quickstart.ts";
import { defaultRepoKey, scanRepo } from "./scan.ts";

export const RUN_JSON = ".tide/run.json";
export const QUICKSTART = "QUICKSTART.md";

export interface LoadedProfile {
  profile?: RunProfile;
  stale: boolean;
  error?: string;
}

interface CacheEntry {
  stamp: string;
  files: string[];
  result: LoadedProfile;
}
const cache = new Map<string, CacheEntry>();

export const invalidate = (repoPath: string): void => void cache.delete(repoPath);
export const clearProfileCache = (): void => cache.clear();

async function stampOf(fs: RepoFs, files: string[]): Promise<string> {
  const parts: string[] = [];
  for (const f of files) parts.push(`${f}=${(await fs.stamp?.(f)) ?? "-"}`);
  return parts.join("|");
}

/** Writes `<repo>/.tide/run.json` and makes sure `.tide/` is in the repo's `info/exclude`. */
export async function saveRunJson(repoPath: string, profile: RunProfile): Promise<void> {
  await mkdir(join(repoPath, ".tide"), { recursive: true });
  await writeFile(join(repoPath, RUN_JSON), `${JSON.stringify(profile, null, 2)}\n`);
  try {
    await ensureExcluded(repoPath);
  } catch {
    // not fatal: the file is written, git just shows it
  }
  invalidate(repoPath);
}

function readStored(text: string | undefined): { profile?: RunProfile; error?: string } {
  if (text === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { error: `${RUN_JSON}: ${(err as Error).message}` };
  }
  if (!Check(RunProfile, value)) {
    const first = Errors(RunProfile, value)[0];
    return { error: `${RUN_JSON}: ${first?.instancePath ?? ""} ${first?.message ?? "invalid run profile"}`.trim() };
  }
  return { profile: value };
}

/**
 * A repo's run profile: QUICKSTART.md block → `.tide/run.json` → manifest scan (then written as
 * `.tide/run.json`). `stale` = the stored manifest hash differs from the manifests on disk now.
 * Cached per path by the stamps of every file it read; `invalidate` drops the entry.
 */
export async function loadRepoProfile(repoPath: string, opts: { repoKey?: string; fs?: RepoFs; write?: boolean; now?: number } = {}): Promise<LoadedProfile> {
  const real = opts.fs === undefined;
  if (real) {
    try {
      if (!(await stat(repoPath)).isDirectory()) return { stale: false, error: `not a directory: ${repoPath}` };
    } catch {
      return { stale: false, error: `path missing on this machine: ${repoPath}` };
    }
  }
  const fs = opts.fs ?? nodeRepoFs(repoPath);
  const hit = real ? cache.get(repoPath) : undefined;
  if (hit !== undefined && (await stampOf(fs, hit.files)) === hit.stamp) return hit.result;

  const repoKey = opts.repoKey ?? defaultRepoKey(repoPath);
  const errors: string[] = [];
  let profile: RunProfile | undefined;
  const qs = await fs.readText(QUICKSTART, 1024 * 1024);
  if (qs !== undefined) {
    const parsed = parseQuickstart(qs);
    if (parsed.profile) profile = { ...parsed.profile, source: "quickstart" };
    if (parsed.error) errors.push(`${QUICKSTART} line ${parsed.error.line}: ${parsed.error.message}`);
  }
  if (profile === undefined) {
    const stored = readStored(await fs.readText(RUN_JSON, 1024 * 1024));
    if (stored.profile) profile = stored.profile;
    if (stored.error) errors.push(stored.error);
  }
  const scan = await scanRepo(fs, { repoKey, grep: profile === undefined, ...(opts.now !== undefined ? { now: opts.now } : {}) });
  let stale = false;
  if (profile === undefined) {
    profile = scan.profile;
    if (opts.write ?? real) await saveRunJson(repoPath, profile);
  } else {
    stale = profile.manifestHash !== "" && profile.manifestHash !== scan.profile.manifestHash;
  }
  const result: LoadedProfile = { profile, stale, ...(errors.length > 0 ? { error: errors.join("; ") } : {}) };
  if (real) {
    const files = [QUICKSTART, RUN_JSON, ...scan.read];
    cache.set(repoPath, { files, stamp: await stampOf(fs, files), result });
  }
  return result;
}

/** The project's stack repos: its root first (at `rootPathOverride`, a thread's worktree, when given), then every linked repo. */
export function projectRepos(model: ReadModel, projectId: string, rootPathOverride?: string): { repoId: string; path: string; label: string }[] | undefined {
  const project = model.projects[projectId];
  if (project === undefined) return undefined;
  return [{ repoId: "root", path: rootPathOverride ?? project.rootPath, label: project.title }, ...(project.links ?? []).map((l) => ({ repoId: l.id, path: l.path, label: l.label }))];
}

interface Owner {
  repo: number;
  ref: string;
  preferred: boolean;
}

/**
 * Cross-repo pass: each `?:<port>` connect becomes `<repoKey>.<serviceId>[.<listen>]` of the one
 * service listening on that port (another repo beats the same repo, default-on beats default-off).
 * Unmatched or ambiguous connects stay as they are and add a warning. Inputs are not mutated.
 */
export function resolveConnects(repos: RunRepo[]): RunRepo[] {
  const owners = new Map<number, Owner[]>();
  repos.forEach((r, repo) => {
    for (const s of r.profile?.services ?? []) {
      for (const l of s.listens) {
        const ref = `${r.profile?.repoKey ?? r.repoKey}.${s.id}${s.listens.length > 1 ? `.${l.name}` : ""}`;
        owners.set(l.port, [...(owners.get(l.port) ?? []), { repo, ref, preferred: s.default !== false }]);
      }
    }
  });
  return repos.map((r, repo) => {
    if (r.profile === undefined) return r;
    const warnings = [...r.profile.warnings];
    const services = r.profile.services.map((s) => ({
      ...s,
      connects: s.connects.map((c) => {
        const m = /^\?:(\d+)$/.exec(c.to);
        if (!m) return c;
        const port = Number(m[1]);
        let pool = owners.get(port) ?? [];
        const others = pool.filter((o) => o.repo !== repo);
        if (others.length > 0) pool = others;
        if (pool.length > 1 && pool.some((o) => o.preferred)) pool = pool.filter((o) => o.preferred);
        const where = `${c.env} on ${r.profile?.repoKey}.${s.id}`;
        if (pool.length === 1) return { ...c, to: (pool[0] as Owner).ref };
        warnings.push(pool.length === 0 ? `${where}: no service in this stack listens on ${port}` : `${where}: port ${port} is claimed by ${pool.map((o) => o.ref).join(", ")}; pick one in the profile`);
        return c;
      }),
    }));
    return { ...r, profile: { ...r.profile, services, warnings } };
  });
}

/** What the model must return; the envelope (repoKey, hash, source, time) is filled in here. */
const ModelAnswer = Type.Object({ services: Type.Array(RunService), warnings: Type.Optional(Type.Array(Type.String())) });

export type InferDeps = Pick<TitleDeps, "registry" | "settings"> & { tideHome?: string };

/** Asks the cheap text model for the profile, from the tree + capped manifests + README head. */
export async function inferWithModel(repoPath: string, deps: InferDeps, opts: { repoKey?: string; fs?: RepoFs; now?: number } = {}): Promise<RunProfile> {
  const fs = opts.fs ?? nodeRepoFs(repoPath);
  const repoKey = opts.repoKey ?? defaultRepoKey(repoPath);
  const scan = await scanRepo(fs, { repoKey });
  const prompt = await buildModelPrompt(fs, repoKey, scan.manifests);
  const pick = await pickProvider(deps);
  const instance = await deps.registry.get(pick.provider);
  const cwd = join(deps.tideHome ?? tmpdir(), "run");
  try {
    mkdirSync(cwd, { recursive: true });
  } catch {
    /* the driver reports a missing cwd itself */
  }
  const answer = await completeJson(instance, {
    schema: ModelAnswer,
    system: MODEL_SYSTEM,
    prompt,
    ...(pick.model !== undefined ? { model: pick.model } : {}),
    cwd,
    maxOutputTokens: 2000,
    timeoutMs: 40_000,
  });
  const seen = new Set<string>();
  const services = answer.services.filter((s) => !seen.has(s.id) && seen.add(s.id));
  const scanWarnings = scan.profile.warnings.filter((w) => !w.startsWith("no dev service"));
  return {
    version: 1,
    repoKey,
    services,
    source: "model",
    manifestHash: scan.profile.manifestHash,
    generatedAt: opts.now ?? Date.now(),
    warnings: [...scanWarnings, ...(answer.warnings ?? [])],
  };
}
