import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Check, Errors } from "typebox/value";
import { RunProfile, type RunRepo } from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import { inferWithModel, invalidate, loadRepoProfile, projectRepos, QUICKSTART, resolveConnects, saveRunJson, type InferDeps } from "../run/profiles.ts";
import { writeQuickstart } from "../run/quickstart.ts";
import { defaultRepoKey, nodeRepoFs, scanRepo } from "../run/scan.ts";
import { RpcException, type RpcRouter } from "./router.ts";

export type RunProfileDeps = InferDeps & { engine: Pick<Engine, "getModel"> };

type RepoRef = { repoId: string; path: string; label: string };

function reposOf(deps: RunProfileDeps, projectId: string): RepoRef[] {
  const repos = projectRepos(deps.engine.getModel(), projectId);
  if (repos === undefined) throw new RpcException("not-found", `unknown project ${projectId}`);
  return repos;
}

function repoOf(deps: RunProfileDeps, projectId: string, repoId: string): RepoRef {
  const repo = reposOf(deps, projectId).find((r) => r.repoId === repoId);
  if (repo === undefined) throw new RpcException("not-found", `unknown repo ${repoId} in project ${projectId}`);
  return repo;
}

async function loadOne(ref: RepoRef): Promise<RunRepo> {
  const base = { repoId: ref.repoId, path: ref.path, label: ref.label, repoKey: defaultRepoKey(ref.path) };
  try {
    const loaded = await loadRepoProfile(ref.path);
    return {
      ...base,
      ...(loaded.profile ? { repoKey: loaded.profile.repoKey, profile: loaded.profile } : {}),
      stale: loaded.stale,
      ...(loaded.error !== undefined ? { error: loaded.error } : {}),
    };
  } catch (err) {
    return { ...base, stale: false, error: (err as Error)?.message ?? String(err) };
  }
}

/** Every repo of the project, loaded (errors per repo, never thrown) and cross-resolved. */
export async function loadProjectRepos(deps: RunProfileDeps, projectId: string): Promise<RunRepo[]> {
  return resolveConnects(await Promise.all(reposOf(deps, projectId).map(loadOne)));
}

/** One repo with `profile` swapped in, resolved against the project's other repos. */
async function withProfile(deps: RunProfileDeps, projectId: string, ref: RepoRef, profile: RunProfile): Promise<RunRepo> {
  const others = await Promise.all(reposOf(deps, projectId).filter((r) => r.repoId !== ref.repoId).map(loadOne));
  const mine: RunRepo = { repoId: ref.repoId, path: ref.path, label: ref.label, repoKey: profile.repoKey, profile, stale: false };
  return resolveConnects([mine, ...others])[0] as RunRepo;
}

export function registerRunProfileHandlers(router: RpcRouter, deps: RunProfileDeps): void {
  router.register("run.profiles.get", async ({ projectId }) => ({ repos: await loadProjectRepos(deps, projectId) }));

  router.register("run.profiles.scan", async ({ projectId, repoId, useModel }) => {
    const ref = repoOf(deps, projectId, repoId);
    invalidate(ref.path);
    const fs = nodeRepoFs(ref.path);
    if (!(await fs.exists(""))) throw new RpcException("not-found", `path missing on this machine: ${ref.path}`);
    const repoKey = defaultRepoKey(ref.path);
    let profile = (await scanRepo(fs, { repoKey })).profile;
    if (useModel === true) {
      try {
        profile = await inferWithModel(ref.path, deps, { repoKey, fs });
      } catch (err) {
        profile = { ...profile, warnings: [...profile.warnings, `model: ${(err as Error)?.message ?? String(err)}`] };
      }
    }
    await saveRunJson(ref.path, profile);
    return withProfile(deps, projectId, ref, profile);
  });

  router.register("run.profiles.set", async ({ projectId, repoId, profile }) => {
    const ref = repoOf(deps, projectId, repoId);
    if (!Check(RunProfile, profile)) {
      const first = Errors(RunProfile, profile)[0];
      throw new RpcException("invalid-params", `invalid run profile: ${first?.instancePath ?? ""} ${first?.message ?? ""}`.trim());
    }
    const fs = nodeRepoFs(ref.path);
    if (!(await fs.exists(""))) throw new RpcException("not-found", `path missing on this machine: ${ref.path}`);
    // hash of the manifests as they are now, so a hand edit is not "stale" the moment it is saved
    const { manifestHash } = (await scanRepo(fs, { repoKey: profile.repoKey, grep: false })).profile;
    const saved: RunProfile = { ...profile, source: "user", manifestHash, generatedAt: Date.now() };
    await saveRunJson(ref.path, saved);
    return withProfile(deps, projectId, ref, saved);
  });

  router.register("run.quickstart.write", async ({ projectId, repoId }) => {
    const ref = repoOf(deps, projectId, repoId);
    const loaded = await loadRepoProfile(ref.path);
    if (loaded.profile === undefined) throw new RpcException("conflict", loaded.error ?? `no run profile for ${ref.path}`);
    const path = join(ref.path, QUICKSTART);
    let existing: string | undefined;
    try {
      existing = await readFile(path, "utf8");
    } catch {
      existing = undefined;
    }
    await writeFile(path, writeQuickstart(existing, loaded.profile));
    invalidate(ref.path);
    return { path };
  });
}
