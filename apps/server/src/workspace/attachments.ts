import { mkdir, readdir, readFile, rm, stat, writeFile, appendFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { newId, type AttachmentRef } from "@tide/contracts";
import { RpcException } from "../rpc/router.ts";
import { Git } from "../vcs/git.ts";

export const MAX_FILES = 10;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const ATTACHMENTS_DIR = ".tide/attachments";
export const GC_AFTER_MS = 30 * 24 * 60 * 60_000;

export interface UploadFile {
  name: string;
  mediaType: string;
  data: string;
}

/** A file name that cannot escape its directory: no separators, NUL, or `.`/`..`-style dot names. */
export function safeName(name: string): string {
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) throw new RpcException("invalid-params", `file name ${JSON.stringify(name)} must not contain path separators`);
  if (name.startsWith("..") || name === "." || name.trim() === "") throw new RpcException("invalid-params", `file name ${JSON.stringify(name)} is not allowed`);
  return name;
}

const decodedSize = (b64: string): number => {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
};

/** Memory of repos whose exclude file was already handled, keyed by the resolved exclude path. */
const excluded = new Set<string>();

/**
 * Appends `.tide/` to the repo's `info/exclude` (never `.gitignore`). `git rev-parse --git-path`
 * resolves `info/exclude` to the common dir for linked worktrees, so one entry covers every worktree.
 */
export async function ensureExcluded(cwd: string, git: Git = new Git(cwd)): Promise<string | undefined> {
  const r = await git.at(cwd).tryRun(["rev-parse", "--git-path", "info/exclude"]);
  if (r.code !== 0) return undefined; // not a git repo: nothing to ignore
  const raw = r.stdout.trim();
  const file = raw.startsWith("/") || /^[A-Za-z]:/.test(raw) ? raw : join(cwd, raw);
  if (excluded.has(file)) return file;
  let current = "";
  try {
    current = await readFile(file, "utf8");
  } catch {
    await mkdir(join(file, ".."), { recursive: true });
  }
  if (!current.split(/\r?\n/).some((l) => l.trim() === ".tide/" || l.trim() === ".tide")) {
    await appendFile(file, `${current === "" || current.endsWith("\n") ? "" : "\n"}.tide/\n`);
  }
  excluded.add(file);
  return file;
}

/** Validates, decodes and writes the files; returns refs relative to `cwd`. */
export async function saveAttachments(cwd: string, files: UploadFile[], opts: { git?: Git } = {}): Promise<AttachmentRef[]> {
  if (files.length === 0) throw new RpcException("invalid-params", "no files");
  if (files.length > MAX_FILES) throw new RpcException("invalid-params", `at most ${MAX_FILES} files per upload`);
  const names = files.map((f) => safeName(f.name));
  const total = files.reduce((n, f) => n + decodedSize(f.data), 0);
  if (total > MAX_TOTAL_BYTES) throw new RpcException("invalid-params", `attachments exceed ${MAX_TOTAL_BYTES / 1024 / 1024} MB in total`);
  const id = newId();
  const dir = join(cwd, ATTACHMENTS_DIR, id);
  await mkdir(dir, { recursive: true });
  await ensureExcluded(cwd, opts.git);
  const used = new Set<string>();
  const refs: AttachmentRef[] = [];
  for (const [i, file] of files.entries()) {
    let name = names[i] as string;
    if (used.has(name)) {
      const dot = name.lastIndexOf(".");
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
      let n = 2;
      while (used.has(`${stem}-${n}${ext}`)) n++;
      name = `${stem}-${n}${ext}`;
    }
    used.add(name);
    const bytes = Buffer.from(file.data, "base64");
    await writeFile(join(dir, name), bytes);
    refs.push({ name, path: relative(cwd, join(dir, name)).split("\\").join("/"), mediaType: file.mediaType, bytes: bytes.length });
  }
  return refs;
}

/** `.tide/attachments/<id>` directories older than `maxAgeMs` under `root`; returns how many were removed. */
export async function sweepAttachments(root: string, now: number, maxAgeMs: number = GC_AFTER_MS): Promise<number> {
  const base = join(root, ATTACHMENTS_DIR);
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    try {
      const info = await stat(join(base, entry));
      if (!info.isDirectory() || now - info.mtimeMs <= maxAgeMs) continue;
      await rm(join(base, entry), { recursive: true, force: true });
      removed++;
    } catch {
      // raced with another sweep
    }
  }
  return removed;
}

const fmtSize = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`);

/** The prompt footer for a user message's file attachments (images carry no `path` and are skipped). */
export function attachmentFooter(attachments: ReadonlyArray<{ mediaType: string; bytes: number; name?: string; path?: string }> | undefined): string {
  const files = (attachments ?? []).filter((a) => a.path !== undefined);
  if (files.length === 0) return "";
  return `\n\nAttached files (read them from disk):\n${files.map((a) => `- ${a.path} (${a.mediaType}, ${fmtSize(a.bytes)})`).join("\n")}`;
}
