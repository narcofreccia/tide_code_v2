import { mkdir, readdir, readFile, realpath, rm, stat, writeFile, appendFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { newId, type AttachmentRef, type ImageInput } from "@tide/contracts";
import { RpcException } from "../rpc/router.ts";
import { Git } from "../vcs/git.ts";

export const MAX_FILES = 10;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const ATTACHMENTS_DIR = ".tide/attachments";
export const GC_AFTER_MS = 30 * 24 * 60 * 60_000;
/** R22: images an agent may hand to another thread in one call, and the size of each */
export const MAX_IMAGE_PATHS = 8;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

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
    const ref: AttachmentRef = { name, path: relative(cwd, join(dir, name)).split("\\").join("/"), mediaType: file.mediaType, bytes: bytes.length };
    if (file.mediaType.startsWith("text/")) ref.lines = countLines(bytes);
    refs.push(ref);
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

/** Newline-separated lines; a trailing newline does not add one. */
const countLines = (bytes: Buffer): number => {
  if (bytes.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < bytes.length - 1; i++) if (bytes[i] === 10) n++;
  return n;
};

const fmtSize = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`);

type FooterEntry = { mediaType: string; bytes: number; name?: string; path?: string; lines?: number; inline?: boolean };

/**
 * The prompt footer for a user message: uploaded files under "Attached files", and (R22) the saved
 * copies of images the harness got as pixels, with what the agent can do with those paths.
 * A legacy image entry (no `path`) is skipped.
 */
export function attachmentFooter(attachments: ReadonlyArray<FooterEntry> | undefined): string {
  const all = attachments ?? [];
  const files = all.filter((a) => a.path !== undefined && a.inline !== true);
  const images = all.filter((a) => a.path !== undefined && a.inline === true);
  let out = "";
  if (files.length > 0) {
    out += `\n\nAttached files (read them from disk):\n${files.map((a) => a.name?.startsWith("pasted-") && a.mediaType === "text/plain"
        ? `- ${a.path} (pasted text${a.lines === undefined ? "" : `, ${a.lines} lines`}, ${fmtSize(a.bytes)})`
        : `- ${a.path} (${a.mediaType}, ${fmtSize(a.bytes)})`).join("\n")}`;
  }
  if (images.length > 0) {
    out += `\n\nAttached images (also saved on disk):\n${images.map((a) => `- ${a.path} (${a.mediaType}, ${fmtSize(a.bytes)})`).join("\n")}\n`
      + "To show one to a sub-agent of your own, put its path in the sub-agent's prompt. "
      + "To show one to another thread, pass its path in `images` to tide_delegate or tide_thread_send.";
  }
  return out;
}

/** True for a server-made image path: `.tide/attachments/...` with no `..` segment. */
const underAttachments = (path: string): boolean => path.startsWith(`${ATTACHMENTS_DIR}/`) && !path.split(/[\\/]/).includes("..");

/**
 * R22: writes the saved copy of each inline image (the i-th inline attachment is the i-th image) to
 * `<cwd>/<path>`, unless it is already there (a turn re-run after a restart). An entry with no
 * matching image (a steer that fell back to a turn of its own) is skipped. Returns how many were written.
 */
export async function saveInlineImages(cwd: string, attachments: ReadonlyArray<FooterEntry> | undefined, images: ReadonlyArray<ImageInput> | undefined, opts: { git?: Git } = {}): Promise<number> {
  const inline = (attachments ?? []).filter((a) => a.inline === true && a.path !== undefined);
  let written = 0;
  let excludedDone = false;
  for (const [i, entry] of inline.entries()) {
    const path = entry.path as string;
    if (!underAttachments(path)) throw new Error(`image path ${path} is outside ${ATTACHMENTS_DIR}/`);
    const image = images?.[i];
    if (image === undefined) continue;
    const file = join(cwd, path);
    if (await exists(file)) continue;
    await mkdir(dirname(file), { recursive: true });
    if (!excludedDone) {
      await ensureExcluded(cwd, opts.git);
      excludedDone = true;
    }
    await writeFile(file, Buffer.from(image.data, "base64"), { flag: "wx" }).catch((err: unknown) => {
      // written by a concurrent run of the same turn: the copy is there, which is all that matters
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    });
    written++;
  }
  return written;
}

const exists = async (file: string): Promise<boolean> => {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
};

/** The image type of `bytes` from its magic numbers; undefined for anything else. */
export function sniffImage(bytes: Uint8Array): string | undefined {
  const at = (offset: number, ascii: string): boolean => [...ascii].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  if (bytes.length >= 8 && bytes[0] === 0x89 && at(1, "PNG\r\n\x1a\n")) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (at(0, "GIF87a") || at(0, "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  return undefined;
}

const badImage = (path: string, why: string): RpcException => new RpcException("invalid-params", `image ${path}: ${why}`);

/**
 * R22: reads image files an agent names (relative to `cwd`, or absolute) back into pixels. Each must
 * resolve, symlinks followed, inside `cwd`, be a regular file of at most 5 MB and be a png, jpeg,
 * gif or webp by its bytes (the extension is not trusted).
 */
export async function readImagePaths(cwd: string, paths: ReadonlyArray<string>): Promise<ImageInput[]> {
  if (paths.length > MAX_IMAGE_PATHS) throw new RpcException("invalid-params", `at most ${MAX_IMAGE_PATHS} images per call (got ${paths.length})`);
  if (paths.length === 0) return [];
  const root = await realpath(cwd);
  const out: ImageInput[] = [];
  for (const path of paths) {
    let real: string;
    try {
      real = await realpath(resolve(root, path));
    } catch {
      throw badImage(path, `no such file in your checkout (${cwd}); give a path relative to it or an absolute one inside it`);
    }
    const rel = relative(root, real);
    if (rel === "" || isAbsolute(rel) || rel.split(sep)[0] === "..") throw badImage(path, `is outside your checkout (${cwd}); only files inside it can be sent`);
    const info = await stat(real);
    if (!info.isFile()) throw badImage(path, "is not a regular file");
    if (info.size > MAX_IMAGE_BYTES) throw badImage(path, `is ${fmtSize(info.size)}; the limit is ${fmtSize(MAX_IMAGE_BYTES)} per image`);
    const bytes = await readFile(real);
    const mediaType = sniffImage(bytes);
    if (mediaType === undefined) throw badImage(path, "is not a png, jpeg, gif or webp image");
    out.push({ mediaType, data: bytes.toString("base64") });
  }
  return out;
}
