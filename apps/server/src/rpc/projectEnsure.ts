import { randomBytes } from "node:crypto";
import { mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { normalizeRemoteUrl, type ProjectIcon, type RpcInput, type RpcOutput } from "@tide/contracts";
import { CommandError, type Engine } from "../orchestration/engine.ts";
import type { SettingsStore } from "../settings.ts";
import { Git } from "../vcs/git.ts";
import { detectRepoIdentity } from "../vcs/repoIdentity.ts";
import { RpcException, type RpcRouter } from "./router.ts";

const CLONE_TIMEOUT_MS = 600_000;
/** folders tried after `<name>`: `<owner>-<name>`, then `<owner>-<name>-2` … */
const MAX_FOLDER_TRIES = 5;

export interface ProjectEnsureDeps {
  engine: Engine;
  settings?: SettingsStore;
  git?: (cwd: string) => Git;
  /** tests point the fallback projects dir at a sandbox */
  homeDir?: () => string;
  cloneTimeoutMs?: number;
  now?: () => number;
}

type Input = RpcInput<"project.ensure">;
type Output = RpcOutput<"project.ensure">;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** One path segment that is a safe folder name on every platform. */
export function safeFolderName(raw: string): string {
  let name = raw.replace(/\.git$/i, "").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
  // Windows drops trailing dots and spaces; a reserved device name stays reserved with an extension
  name = name.replace(/\.+$/, "");
  if (name === "" || name === "." || name === ".." || WINDOWS_RESERVED.test(name.split(".")[0] ?? "")) name = `repo-${name}`.slice(0, 80);
  return name;
}

/** `host/owner/name` → `name`; the folder a clone lands in. */
export function repoFolderName(remoteUrl: string): string {
  const last = remoteUrl.split(/[/\\]/).filter((s) => s !== "").pop() ?? "";
  if (last.replace(/\.git$/i, "") === "") throw new RpcException("invalid-params", `cannot derive a folder name from ${remoteUrl}`);
  return safeFolderName(last);
}

/** `<name>`, then `<owner>-<name>`, then `<owner>-<name>-<n>`: where a clone may land. */
export function folderCandidates(remoteUrl: string): string[] {
  const name = repoFolderName(remoteUrl);
  const segments = remoteUrl.split(/[/\\]/).filter((s) => s !== "");
  const owner = segments.length >= 2 ? safeFolderName(segments[segments.length - 2] ?? "") : undefined;
  if (owner === undefined) return [name];
  const both = safeFolderName(`${owner}-${name}`);
  return [name, both, ...Array.from({ length: MAX_FOLDER_TRIES - 2 }, (_, i) => safeFolderName(`${owner}-${name}-${i + 2}`))];
}

/** git check-ref-format --branch, for a name another machine sent us. */
export function isValidBranchName(name: string): boolean {
  if (name === "" || name === "@" || name.length > 255 || name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  // control characters (incl. DEL), space and the characters git forbids anywhere in a ref
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name) || name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  return name.split("/").every((c) => c !== "" && !c.startsWith(".") && !c.toLowerCase().endsWith(".lock"));
}

/**
 * A clone URL another machine sent us: https/http/ssh/git, scp-style `user@host:path`, or a local
 * absolute path. Option-looking URLs and git's helper transports (`ext::`, `fd::`, …) are refused.
 */
export function isAllowedCloneUrl(url: string): boolean {
  if (url === "" || url.startsWith("-") || /[\x00-\x1f\x7f]/.test(url)) return false;
  if (/^[A-Za-z0-9+.-]+::/.test(url)) return false; // <transport>::<address>
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
  if (scheme !== null) {
    // a host that looks like an option (`ssh://-oProxyCommand=…`) is refused as well
    const host = url.slice(scheme[0].length).replace(/^[^@/]*@/, "");
    return ["https", "http", "ssh", "git", "file"].includes((scheme[1] ?? "").toLowerCase()) && !host.startsWith("-");
  }
  if (url.startsWith("/") || /^[A-Za-z]:[\\/]/.test(url) || url.startsWith("\\\\")) return true; // posix, drive, UNC
  // scp-style: [user@]host:path, where the host is not a single drive letter
  const scp = /^(?:([A-Za-z0-9._~-]+)@)?([A-Za-z0-9.][A-Za-z0-9.-]*):(?!\/\/)\S+$/.exec(url);
  return scp !== null && (scp[1] !== undefined || (scp[2] ?? "").length > 1);
}

/** `child` is strictly inside `parent` once both are resolved. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
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

/** Removes `<name>.partial-*` folders older than `maxAgeMs`: clones a crash or a kill left behind. */
async function removeStalePartials(dir: string, names: string[], maxAgeMs: number, now: number): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!names.some((n) => entry.startsWith(`${n}.partial-`))) continue;
    const full = join(dir, entry);
    const info = await stat(full).catch(() => undefined);
    if (info !== undefined && now - info.mtimeMs > maxAgeMs) await rm(full, { recursive: true, force: true }).catch(() => undefined);
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

    if (!isValidBranchName(input.repo.defaultBranch)) throw new RpcException("invalid-params", `${JSON.stringify(input.repo.defaultBranch)} is not a valid branch name`);
    if (!isAllowedCloneUrl(input.repo.cloneUrl)) throw new RpcException("invalid-params", `clone URL ${JSON.stringify(input.repo.cloneUrl)} is not allowed: use https, ssh, git, user@host:path or a local absolute path`);

    const home = deps.homeDir?.() ?? homedir();
    const configured = input.parentDir ?? deps.settings?.get().environment.projectsDir;
    // a setting typed as `~/code` means this machine's home
    const dir = configured === undefined ? join(home, "tide-projects") : configured === "~" ? home : configured.startsWith("~/") ? join(home, configured.slice(2)) : configured;
    if (!isAbsolute(dir)) throw new RpcException("invalid-params", `projects folder ${dir} must be absolute`);
    const names = folderCandidates(key);
    const timeoutMs = deps.cloneTimeoutMs ?? CLONE_TIMEOUT_MS;
    await removeStalePartials(dir, names, timeoutMs, deps.now?.() ?? Date.now());

    let root: string | undefined;
    for (const name of names) {
      const candidate = join(dir, name);
      if (!isInside(dir, candidate)) throw new RpcException("invalid-params", `${candidate} is outside ${dir}`);
      if (!(await exists(candidate))) {
        root = candidate;
        break;
      }
      // the folder itself must be the repo root: a plain folder inside some other checkout is not a clone
      const top = await git(candidate).tryRun(["rev-parse", "--show-toplevel"]);
      const isRoot = top.code === 0 && (await realpath(top.stdout.trim()).catch(() => "")) === (await realpath(candidate));
      const origin = isRoot ? await git(candidate).tryRun(["remote", "get-url", "origin"]) : undefined;
      if (origin !== undefined && origin.code === 0 && normalizeRemoteUrl(origin.stdout.trim()) === key) {
        return { projectId: await createProject(candidate, input.title, input.icon), rootPath: candidate, cloned: false };
      }
      // taken by something else (same name, another owner): try the next name
    }
    if (root === undefined) throw new RpcException("conflict", `${join(dir, names[0] ?? "")} and ${names.length - 1} fallback folder(s) exist and none is a clone of ${key}`);

    // clone beside the target and rename on success: a failed or timed-out clone never leaves a half folder at `root`
    await mkdir(dir, { recursive: true });
    const partial = `${root}.partial-${randomBytes(4).toString("hex")}`;
    const clone = await git(dir)
      .withTimeout(timeoutMs)
      .tryRun(["clone", "--branch", input.repo.defaultBranch, "--", input.repo.cloneUrl, partial]);
    if (clone.code !== 0) {
      await rm(partial, { recursive: true, force: true }).catch(() => undefined);
      const stderr = clone.stderr.trim();
      throw new RpcException("internal", `git clone ${input.repo.cloneUrl} failed${stderr !== "" ? `: ${stderr}` : ` (exit ${clone.code})`}`);
    }
    try {
      await rename(partial, root);
    } catch (err) {
      await rm(partial, { recursive: true, force: true }).catch(() => undefined);
      throw new RpcException("conflict", `could not move the clone to ${root}: ${err instanceof Error ? err.message : String(err)}`);
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
