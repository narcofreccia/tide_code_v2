import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiffFile } from "@tide/contracts";
import { parseNameStatus, parseNumstat, type RawDiffEntry } from "./diffParse.ts";

/** Sentinel `head` meaning "the working tree" (tracked changes + untracked files). */
export const WORKTREE = "WORKTREE";
/** Per-file patches above this are cut; the marker is appended to the patch text. */
export const MAX_PATCH_BYTES = 200 * 1024;
const MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
/** Identity for Tide's own plumbing commits (checkpoints); never used for user commits. */
const TIDE_IDENTITY = ["-c", "user.name=Tide", "-c", "user.email=tide@localhost"];

export class GitError extends Error {
  readonly args: string[];
  readonly exitCode: number;
  readonly stderr: string;
  constructor(args: string[], exitCode: number, stderr: string) {
    super(`git ${args.join(" ")} failed (${exitCode}): ${stderr.trim().split("\n")[0] ?? ""}`);
    this.name = "GitError";
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
}

export interface AheadBehind {
  ahead: number;
  behind: number;
}

export interface DiffOptions {
  /** skip per-file patches (numstat/name-status only) */
  stat?: boolean;
}

export interface FileAt {
  content?: string;
  binary: boolean;
  missing: boolean;
}

export interface GitOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Thin async wrapper over the `git` binary. Args are always arrays — never a shell string. */
export class Git {
  readonly cwd: string;
  #env: NodeJS.ProcessEnv;
  #timeoutMs: number;

  constructor(cwd: string, options: GitOptions = {}) {
    this.cwd = cwd;
    this.#env = options.env ?? process.env;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  at(cwd: string): Git {
    return new Git(cwd, { env: this.#env, timeoutMs: this.#timeoutMs });
  }

  /** Runs git and never throws; inspect `code`. */
  tryRun(args: string[], env?: NodeJS.ProcessEnv): Promise<GitRun> {
    return new Promise((resolve) => {
      execFile(
        "git",
        ["--no-pager", ...args],
        {
          cwd: this.cwd,
          env: { ...this.#env, ...env, GIT_TERMINAL_PROMPT: "0" },
          maxBuffer: MAX_BUFFER,
          timeout: this.#timeoutMs,
          encoding: "utf8",
        },
        (err, stdout, stderr) => {
          const code = err === null ? 0 : typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1;
          resolve({ code, stdout: stdout ?? "", stderr: stderr ?? (err === null ? "" : String(err.message)) });
        },
      );
    });
  }

  /** Runs git and throws GitError on a non-zero exit. Returns stdout. */
  async run(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    const result = await this.tryRun(args, env);
    if (result.code !== 0) throw new GitError(args, result.code, result.stderr);
    return result.stdout;
  }

  /** Runs git with `input` written to stdin; never throws. Used by `check-ignore --stdin`. */
  tryRunWithInput(args: string[], input: string): Promise<GitRun> {
    return new Promise((resolve) => {
      const child = execFile(
        "git",
        ["--no-pager", ...args],
        {
          cwd: this.cwd,
          env: { ...this.#env, GIT_TERMINAL_PROMPT: "0" },
          maxBuffer: MAX_BUFFER,
          timeout: this.#timeoutMs,
          encoding: "utf8",
        },
        (err, stdout, stderr) => {
          const code = err === null ? 0 : typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1;
          resolve({ code, stdout: stdout ?? "", stderr: stderr ?? (err === null ? "" : String(err.message)) });
        },
      );
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input);
    });
  }

  /** Raw bytes, for content that may be binary. */
  runBuffer(args: string[]): Promise<{ code: number; stdout: Buffer; stderr: string }> {
    return new Promise((resolve) => {
      execFile(
        "git",
        ["--no-pager", ...args],
        { cwd: this.cwd, env: { ...this.#env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: MAX_BUFFER, timeout: this.#timeoutMs, encoding: "buffer" },
        (err, stdout, stderr) => {
          const code = err === null ? 0 : typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1;
          resolve({ code, stdout: stdout ?? Buffer.alloc(0), stderr: (stderr ?? Buffer.alloc(0)).toString("utf8") });
        },
      );
    });
  }

  // ---- repo state ----

  async isRepo(): Promise<boolean> {
    const r = await this.tryRun(["rev-parse", "--is-inside-work-tree"]);
    return r.code === 0 && r.stdout.trim() === "true";
  }

  async toplevel(): Promise<string | undefined> {
    const r = await this.tryRun(["rev-parse", "--show-toplevel"]);
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  /** undefined when HEAD is detached or the repo has no commits yet. */
  async currentBranch(): Promise<string | undefined> {
    const r = await this.tryRun(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (r.code !== 0) return undefined;
    const name = r.stdout.trim();
    return name === "" ? undefined : name;
  }

  async revParse(ref: string): Promise<string | undefined> {
    const r = await this.tryRun(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (r.code !== 0) {
      const plain = await this.tryRun(["rev-parse", "--verify", "--quiet", ref]);
      return plain.code === 0 && plain.stdout.trim() !== "" ? plain.stdout.trim() : undefined;
    }
    return r.stdout.trim() === "" ? undefined : r.stdout.trim();
  }

  /** porcelain v2 → number of changed entries (tracked + untracked, ignored excluded). */
  async status(): Promise<{ dirty: number }> {
    const r = await this.tryRun(["status", "--porcelain=v2", "--untracked-files=normal", "-z"]);
    if (r.code !== 0) return { dirty: 0 };
    let dirty = 0;
    for (const line of r.stdout.split("\0")) {
      const head = line.slice(0, 2);
      if (head === "1 " || head === "2 " || head === "u " || head === "? ") dirty++;
    }
    return { dirty };
  }

  async aheadBehind(): Promise<AheadBehind | undefined> {
    const r = await this.tryRun(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
    if (r.code !== 0) return undefined;
    const [ahead, behind] = r.stdout.trim().split(/\s+/).map((n) => Number(n));
    if (ahead === undefined || behind === undefined || Number.isNaN(ahead) || Number.isNaN(behind)) return undefined;
    return { ahead, behind };
  }

  async hasRemote(): Promise<boolean> {
    const r = await this.tryRun(["remote"]);
    return r.code === 0 && r.stdout.trim() !== "";
  }

  // ---- worktrees ----

  /** Creates `path` on `branch`, forked from `base`. Reuses the branch when it already exists. */
  async worktreeAdd(path: string, branch: string, base: string): Promise<void> {
    const exists = await this.tryRun(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    const args = exists.code === 0 ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, base];
    await this.run(args);
  }

  async worktreeRemove(path: string, force = false): Promise<void> {
    await this.run(["worktree", "remove", ...(force ? ["--force"] : []), path]);
  }

  async worktreeList(): Promise<WorktreeEntry[]> {
    const r = await this.tryRun(["worktree", "list", "--porcelain"]);
    if (r.code !== 0) return [];
    const out: WorktreeEntry[] = [];
    let current: WorktreeEntry | undefined;
    for (const line of r.stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current) out.push(current);
        current = { path: line.slice("worktree ".length), detached: false };
      } else if (current && line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
      else if (current && line.startsWith("branch ")) current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      else if (current && line === "detached") current.detached = true;
    }
    if (current) out.push(current);
    return out;
  }

  /** `git branch -D`; false when git refused (unknown branch, still checked out). */
  async deleteBranch(name: string): Promise<boolean> {
    const r = await this.tryRun(["branch", "-D", name]);
    return r.code === 0;
  }

  // ---- refs ----

  async updateRef(ref: string, sha: string): Promise<void> {
    await this.run(["update-ref", ref, sha]);
  }

  async deleteRef(ref: string): Promise<void> {
    await this.tryRun(["update-ref", "-d", ref]);
  }

  async listRefs(prefix: string): Promise<{ ref: string; sha: string }[]> {
    const r = await this.tryRun(["for-each-ref", "--format=%(refname) %(objectname)", prefix]);
    if (r.code !== 0) return [];
    return r.stdout
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => {
        const [ref, sha] = l.split(" ");
        return { ref: ref ?? "", sha: sha ?? "" };
      });
  }

  // ---- checkpoints ----

  /**
   * Commit sha capturing the whole working tree — including untracked, gitignore-respecting —
   * without touching the real index or HEAD. Uses a throwaway `GIT_INDEX_FILE`, writes a tree
   * from it and wraps that tree with `commit-tree` parented on HEAD (parentless on an unborn
   * branch). Nothing is ever written to any ref here; the caller decides where to point.
   */
  async snapshot(message = "tide checkpoint"): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "tide-index-"));
    const indexFile = join(dir, "index");
    try {
      await this.run(["add", "-A"], { GIT_INDEX_FILE: indexFile });
      const tree = (await this.run(["write-tree"], { GIT_INDEX_FILE: indexFile })).trim();
      const head = await this.revParse("HEAD");
      const args = [...TIDE_IDENTITY, "commit-tree", tree, ...(head ? ["-p", head] : []), "-m", message];
      return (await this.run(args)).trim();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Restores the working tree to `ref` **without moving HEAD or any branch**:
   * `read-tree --reset -u` rewrites index + working tree to the ref's tree (deleting tracked
   * files absent from it), then `clean -fd` removes files created after the checkpoint. Because
   * a snapshot tree contains every non-ignored file, everything from the checkpoint is in the
   * index after read-tree, so `clean` only ever removes post-checkpoint additions; ignored
   * files (node_modules, build output) are untouched since `-x` is deliberately not passed.
   */
  async checkoutTree(ref: string): Promise<void> {
    await this.run(["read-tree", "--reset", "-u", ref]);
    await this.run(["clean", "-fd"]);
  }

  // ---- commit / push ----

  /** Stages everything and commits. Returns undefined when there was nothing to commit. */
  async commitAll(message: string): Promise<string | undefined> {
    await this.run(["add", "-A"]);
    const staged = await this.tryRun(["diff", "--cached", "--quiet"]);
    if (staged.code === 0) return undefined;
    await this.run(["-c", "commit.gpgsign=false", "commit", "-m", message]);
    return this.revParse("HEAD");
  }

  async push(branch: string, remote = "origin"): Promise<void> {
    await this.run(["push", "-u", remote, branch]);
  }

  // ---- read / diff ----

  /** File content at a ref; `WORKTREE` reads from disk. */
  async show(ref: string, path: string): Promise<FileAt> {
    if (ref === WORKTREE) {
      try {
        const buf = await readFile(join(this.cwd, path));
        return isBinary(buf) ? { binary: true, missing: false } : { content: buf.toString("utf8"), binary: false, missing: false };
      } catch {
        return { binary: false, missing: true };
      }
    }
    const r = await this.runBuffer(["show", `${ref}:${path}`]);
    if (r.code !== 0) return { binary: false, missing: true };
    return isBinary(r.stdout) ? { binary: true, missing: false } : { content: r.stdout.toString("utf8"), binary: false, missing: false };
  }

  /** Structured diff `base` → `head` (`WORKTREE` = working tree incl. untracked files). */
  async diff(base: string, head: string, options: DiffOptions = {}): Promise<DiffFile[]> {
    const range = head === WORKTREE ? [base] : [base, head];
    const numstat = parseNumstat(await this.run(["diff", "--numstat", "-M", "-z", ...range]));
    const nameStatus = parseNameStatus(await this.run(["diff", "--name-status", "-M", "-z", ...range]));
    const entries: RawDiffEntry[] = numstat.map((n) => ({ ...n, status: nameStatus.get(n.path) ?? (n.oldPath !== undefined ? "renamed" : "modified") }));

    const files: DiffFile[] = [];
    for (const e of entries) {
      files.push(await this.#toDiffFile(e, range, options));
    }
    if (head === WORKTREE) files.push(...(await this.#untracked(options)));
    files.sort((a, b) => a.path.localeCompare(b.path));
    return files;
  }

  async #toDiffFile(e: RawDiffEntry, range: string[], options: DiffOptions): Promise<DiffFile> {
    const file: DiffFile = {
      path: e.path,
      ...(e.oldPath !== undefined ? { oldPath: e.oldPath } : {}),
      status: e.status,
      additions: e.additions,
      deletions: e.deletions,
      ...(e.binary ? { binary: true } : {}),
    };
    if (options.stat === true || e.binary) return file;
    const paths = e.oldPath !== undefined ? [e.oldPath, e.path] : [e.path];
    const patch = await this.tryRun(["diff", "--no-color", "-M", ...range, "--", ...paths]);
    if (patch.code === 0 && patch.stdout !== "") file.patch = capPatch(patch.stdout);
    return file;
  }

  /** Untracked, non-ignored files rendered as additions against /dev/null. */
  async #untracked(options: DiffOptions): Promise<DiffFile[]> {
    const listed = await this.tryRun(["ls-files", "--others", "--exclude-standard", "-z"]);
    if (listed.code !== 0) return [];
    const out: DiffFile[] = [];
    for (const path of listed.stdout.split("\0").filter((p) => p !== "")) {
      const stat = await this.tryRun(["diff", "--no-index", "--numstat", "-z", "--", "/dev/null", path]);
      const parsed = parseNumstat(stat.stdout)[0];
      const file: DiffFile = {
        path,
        status: "added",
        additions: parsed?.additions ?? 0,
        deletions: 0,
        ...(parsed?.binary === true ? { binary: true } : {}),
      };
      if (options.stat !== true && parsed?.binary !== true) {
        const patch = await this.tryRun(["diff", "--no-color", "--no-index", "--", "/dev/null", path]);
        if (patch.stdout !== "") file.patch = capPatch(patch.stdout.replace(/^(--- |\+\+\+ )a?\/dev\/null$/m, "--- /dev/null"));
      }
      out.push(file);
    }
    return out;
  }
}

export function capPatch(patch: string): string {
  if (Buffer.byteLength(patch, "utf8") <= MAX_PATCH_BYTES) return patch;
  return `${patch.slice(0, MAX_PATCH_BYTES)}\n… patch truncated at ${MAX_PATCH_BYTES} bytes …\n`;
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}
