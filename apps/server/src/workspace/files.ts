import { randomBytes } from "node:crypto";
import { constants as FS } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { FsEntry } from "@tide/contracts";
import { RpcException } from "../rpc/router.ts";
import { checkIgnore, isGitInternal, type GitFactory } from "./ignore.ts";
import { resolveInside } from "./paths.ts";

/** Files at or above this are reported as binary without being read. */
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
/** A NUL in this prefix means "binary". */
export const BINARY_SNIFF_BYTES = 8 * 1024;

export interface FileServiceOptions {
  /** thread -> cwd (worktree path or project root); throws `not-found` for unknown threads */
  cwdFor: (threadId: string) => string;
  git?: GitFactory;
}

export interface ReadResult {
  content?: string;
  binary: boolean;
  size: number;
  mtime: number;
}

/** Integer ms so `ifMtime` round-trips through JSON and compares exactly. */
export const mtimeOf = (mtimeMs: number): number => Math.floor(mtimeMs);

const errno = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | undefined)?.code;

function mapFsError(err: unknown, path: string): never {
  const code = errno(err);
  if (code === "ENOENT") throw new RpcException("not-found", `no such file ${path}`);
  if (code === "EEXIST") throw new RpcException("conflict", `${path} already exists`);
  if (code === "ENOTDIR" || code === "EISDIR") throw new RpcException("invalid-params", `${path} is not of the expected kind`);
  if (code === "EACCES" || code === "EPERM") throw new RpcException("invalid-params", `${path} is not accessible`);
  throw err;
}

export function isBinaryBuffer(buf: Buffer): boolean {
  const end = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) if (buf[i] === 0) return true;
  return false;
}

/** dirs first, then files, case-insensitive, ties broken by the raw name. */
function compareEntries(a: FsEntry, b: FsEntry): number {
  const rank = (e: FsEntry): number => (e.kind === "dir" ? 0 : 1);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const al = a.name.toLowerCase();
  const bl = b.name.toLowerCase();
  if (al !== bl) return al < bl ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Filesystem operations scoped to a thread's working directory. */
export class FileService {
  #cwdFor: (threadId: string) => string;
  #git: GitFactory | undefined;

  constructor(options: FileServiceOptions) {
    this.#cwdFor = options.cwdFor;
    this.#git = options.git;
  }

  cwd(threadId: string): string {
    return this.#cwdFor(threadId);
  }

  async list(threadId: string, path?: string): Promise<FsEntry[]> {
    const cwd = this.#cwdFor(threadId);
    const { abs, rel } = await resolveInside(cwd, path ?? "", { allowRoot: true });
    let dirents;
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch (err) {
      mapFsError(err, path ?? ".");
    }

    const entries: FsEntry[] = [];
    for (const dirent of dirents) {
      if (dirent.name === ".git") continue;
      const childRel = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
      const kind = dirent.isDirectory() ? "dir" : dirent.isSymbolicLink() ? "symlink" : "file";
      let size: number | undefined;
      let mtime: number | undefined;
      try {
        const st = await lstat(join(abs, dirent.name));
        size = st.size;
        mtime = mtimeOf(st.mtimeMs);
      } catch {
        // raced with a delete: still list the name, without stats
      }
      entries.push({
        name: dirent.name,
        path: childRel,
        kind,
        ...(size !== undefined ? { size } : {}),
        ...(mtime !== undefined ? { mtime } : {}),
      });
    }

    const ignored = await checkIgnore(cwd, entries.map((e) => e.path), this.#git);
    for (const entry of entries) entry.ignored = ignored.has(entry.path);
    entries.sort(compareEntries);
    return entries;
  }

  async read(threadId: string, path: string): Promise<ReadResult> {
    const cwd = this.#cwdFor(threadId);
    const { abs } = await resolveInside(cwd, path);
    let st;
    try {
      st = await stat(abs);
    } catch (err) {
      mapFsError(err, path);
    }
    if (st.isDirectory()) throw new RpcException("invalid-params", `${path} is a directory`);
    const mtime = mtimeOf(st.mtimeMs);
    if (st.size > MAX_TEXT_BYTES) return { binary: true, size: st.size, mtime };
    let buf: Buffer;
    try {
      buf = await readFile(abs);
    } catch (err) {
      mapFsError(err, path);
    }
    if (isBinaryBuffer(buf)) return { binary: true, size: buf.length, mtime };
    return { content: buf.toString("utf8"), binary: false, size: buf.length, mtime };
  }

  /** Atomic: writes a sibling temp file and renames it over the target. */
  async write(threadId: string, path: string, content: string, ifMtime?: number): Promise<{ mtime: number }> {
    const cwd = this.#cwdFor(threadId);
    const { abs } = await resolveInside(cwd, path);
    let mode: number | undefined;
    if (ifMtime !== undefined) {
      const current = await stat(abs).catch(() => undefined);
      if (current === undefined || mtimeOf(current.mtimeMs) !== ifMtime) {
        throw new RpcException("conflict", "file changed on disk");
      }
      mode = current.mode;
    } else {
      mode = (await stat(abs).catch(() => undefined))?.mode;
    }

    const dir = dirname(abs);
    await mkdir(dir, { recursive: true });
    const temp = join(dir, `.${basename(abs)}.${randomBytes(6).toString("hex")}.tide-tmp`);
    try {
      await writeFile(temp, content, mode !== undefined ? { encoding: "utf8", mode } : { encoding: "utf8" });
      await rename(temp, abs);
    } catch (err) {
      await unlink(temp).catch(() => undefined);
      mapFsError(err, path);
    }
    const st = await stat(abs);
    return { mtime: mtimeOf(st.mtimeMs) };
  }

  async create(threadId: string, path: string, kind: "file" | "dir"): Promise<void> {
    const cwd = this.#cwdFor(threadId);
    const { abs } = await resolveInside(cwd, path);
    if (kind === "dir") {
      try {
        await mkdir(abs, { recursive: true });
      } catch (err) {
        mapFsError(err, path);
      }
      return;
    }
    await mkdir(dirname(abs), { recursive: true });
    try {
      await writeFile(abs, "", { flag: "wx" });
    } catch (err) {
      mapFsError(err, path);
    }
  }

  async rename(threadId: string, from: string, to: string): Promise<void> {
    const cwd = this.#cwdFor(threadId);
    const src = await resolveInside(cwd, from);
    const dst = await resolveInside(cwd, to);
    const exists = await access(dst.abs, FS.F_OK).then(
      () => true,
      () => false,
    );
    if (exists) throw new RpcException("conflict", `${to} already exists`);
    await mkdir(dirname(dst.abs), { recursive: true });
    try {
      await rename(src.abs, dst.abs);
    } catch (err) {
      mapFsError(err, from);
    }
  }

  /** Recursive for directories. The cwd itself is never deletable (`resolveInside` rejects it). */
  async delete(threadId: string, path: string): Promise<void> {
    const cwd = this.#cwdFor(threadId);
    const { abs, rel } = await resolveInside(cwd, path);
    if (isGitInternal(rel)) throw new RpcException("invalid-params", "refusing to delete inside .git");
    try {
      await rm(abs, { recursive: true });
    } catch (err) {
      mapFsError(err, path);
    }
  }
}
