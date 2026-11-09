import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { normalizeRemoteUrl, type ProjectIcon, type RpcInput, type RpcOutput } from "@tide/contracts";
import { CommandError, type Engine } from "../orchestration/engine.ts";
import type { SettingsStore } from "../settings.ts";
import { Git } from "../vcs/git.ts";
import { detectRepoIdentity } from "../vcs/repoIdentity.ts";
import { RpcException, type RpcRouter } from "./router.ts";

const CLONE_TIMEOUT_MS = 600_000;

export interface ProjectEnsureDeps {
  engine: Engine;
  settings?: SettingsStore;
  git?: (cwd: string) => Git;
  /** tests point the fallback projects dir at a sandbox */
  homeDir?: () => string;
}

type Input = RpcInput<"project.ensure">;
type Output = RpcOutput<"project.ensure">;

/** `host/owner/name` → `name`; the folder a clone lands in. */
function repoFolderName(remoteUrl: string): string {
  const last = remoteUrl.split("/").filter((s) => s !== "").pop() ?? "";
  if (last === "" || last === "." || last === "..") throw new RpcException("invalid-params", `cannot derive a folder name from ${remoteUrl}`);
  return last;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * R17 B3: make sure this machine has a checkout of `repo` and a project for it. Reuses a project
 * with the same repo key, adopts an existing clone at the target path, otherwise clones. The
 * harness never sees this; it only makes "Run on <machine>" land in a real worktree.
 */
export function registerProjectEnsure(router: RpcRouter, deps: ProjectEnsureDeps): void {
  const git = deps.git ?? ((cwd: string) => new Git(cwd));
  const inFlight = new Map<string, Promise<Output>>();

  const dispatch = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof CommandError) throw new RpcException(err.code, err.message);
      throw err;
    }
  };

  const createProject = async (rootPath: string, title: string, icon: ProjectIcon | undefined): Promise<string> => {
    const repo = await detectRepoIdentity(rootPath, git(rootPath)).catch(() => undefined);
    const result = await dispatch(() =>
      deps.engine.dispatch({ type: "project.create", title, rootPath, ...(icon !== undefined ? { icon } : {}), ...(repo !== undefined ? { repo } : {}) }),
    );
    const created = result.events[0]?.event;
    if (created?.type !== "project.created") throw new RpcException("internal", "project.create produced no project");
    return created.project.id;
  };

  const ensure = async (input: Input): Promise<Output> => {
    const key = input.repo.remoteUrl;
    const projects = Object.values(deps.engine.getModel().projects).filter((p) => p.repo?.remoteUrl === key);
    const live = projects.find((p) => p.archivedAt === undefined);
    if (live) return { projectId: live.id, rootPath: live.rootPath, cloned: false };
    const archived = projects[0];
    if (archived) {
      await dispatch(() => deps.engine.dispatch({ type: "project.unarchive", projectId: archived.id }));
      return { projectId: archived.id, rootPath: archived.rootPath, cloned: false };
    }

    const home = deps.homeDir?.() ?? homedir();
    const configured = input.parentDir ?? deps.settings?.get().environment.projectsDir;
    // a setting typed as `~/code` means this machine's home
    const dir = configured === undefined ? join(home, "tide-projects") : configured === "~" ? home : configured.startsWith("~/") ? join(home, configured.slice(2)) : configured;
    if (!isAbsolute(dir)) throw new RpcException("invalid-params", `projects folder ${dir} must be absolute`);
    const root = join(dir, repoFolderName(key));

    if (await exists(root)) {
      // the folder itself must be the repo root: a plain folder inside some other checkout is not a clone
      const top = await git(root).tryRun(["rev-parse", "--show-toplevel"]);
      const isRoot = top.code === 0 && (await realpath(top.stdout.trim()).catch(() => "")) === (await realpath(root));
      const origin = isRoot ? await git(root).tryRun(["remote", "get-url", "origin"]) : undefined;
      if (origin === undefined || origin.code !== 0 || normalizeRemoteUrl(origin.stdout.trim()) !== key) {
        throw new RpcException("conflict", `${root} exists and is not a clone of ${key}`);
      }
      return { projectId: await createProject(root, input.title, input.icon), rootPath: root, cloned: false };
    }

    await mkdir(dir, { recursive: true });
    const clone = await git(dir)
      .withTimeout(CLONE_TIMEOUT_MS)
      .tryRun(["clone", "--branch", input.repo.defaultBranch, "--", input.repo.cloneUrl, root]);
    if (clone.code !== 0) {
      const stderr = clone.stderr.trim();
      throw new RpcException("internal", `git clone ${input.repo.cloneUrl} failed${stderr !== "" ? `: ${stderr}` : ` (exit ${clone.code})`}`);
    }
    return { projectId: await createProject(root, input.title, input.icon), rootPath: root, cloned: true };
  };

  router.register("project.ensure", async (input, ctx) => {
    if (ctx.agentThreadId !== undefined) throw new RpcException("forbidden", "agents cannot create projects");
    const key = input.repo.remoteUrl;
    const pending = inFlight.get(key);
    if (pending) return pending;
    const job = ensure(input).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
    return job;
  });
}
