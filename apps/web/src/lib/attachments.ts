import type { AttachmentRef } from "@tide/contracts";
import { call } from "../state/model.ts";
import type { DraftFile } from "../state/drafts.ts";
import { isSupportedImage } from "./images.ts";

/**
 * Non-image files the composer attaches. They are written into the thread's cwd by
 * `attachments.upload` on send, then referenced by path in the turn, so the harness
 * reads the real bytes with its own tools. The server caps the same numbers.
 */
export const MAX_FILES = 10;
export const MAX_FILES_BYTES = 20 * 1024 * 1024;

export type { DraftFile };

/**
 * The bytes of pending files, for this tab's lifetime only. A draft restored after a
 * reload keeps the chips but not the contents; the composer asks for a re-attach.
 */
const blobs = new Map<string, File>();
let seq = 1;

export function rememberFile(file: File): DraftFile {
  const id = `file-${Date.now().toString(36)}-${seq++}`;
  blobs.set(id, file);
  return { id, name: file.name || "file", mediaType: file.type || "application/octet-stream", bytes: file.size };
}

export function fileBytesAvailable(id: string): boolean {
  return blobs.has(id);
}

export function forgetFiles(ids: readonly string[]): void {
  for (const id of ids) blobs.delete(id);
}

/** Splits a paste/drop/picker selection into inline images and on-disk files. */
export function splitFiles(files: readonly File[], imagesInline: boolean): { images: File[]; files: File[] } {
  const images: File[] = [];
  const rest: File[] = [];
  for (const file of files) {
    if (imagesInline && isSupportedImage(file.type)) images.push(file);
    else rest.push(file);
  }
  return { images, files: rest };
}

/** Every file a paste or drop carries, images included, in order. */
export function filesOf(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  const files = Array.from(transfer.files ?? []);
  if (files.length > 0) return files;
  const out: File[] = [];
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  return out;
}

export function transferHasFiles(transfer: DataTransfer | null): boolean {
  return (transfer?.types ?? []).includes("Files") || filesOf(transfer).length > 0;
}

/** Adds what fits under the caps; returns the accepted list and a reason for what was left out. */
export function admitFiles(
  current: readonly DraftFile[],
  incoming: readonly DraftFile[],
): { files: DraftFile[]; refused?: string } {
  const out = [...current];
  let total = out.reduce((sum, f) => sum + f.bytes, 0);
  let refused: string | undefined;
  for (const file of incoming) {
    if (out.length >= MAX_FILES) {
      refused = `At most ${MAX_FILES} files per message`;
      break;
    }
    if (total + file.bytes > MAX_FILES_BYTES) {
      refused = `Attachments are limited to 20 MB per message; ${file.name} does not fit`;
      continue;
    }
    out.push(file);
    total += file.bytes;
  }
  return refused === undefined ? { files: out } : { files: out, refused };
}

function readBase64(file: Blob, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${name}`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma < 0 ? "" : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** Writes the pending files into the thread cwd; throws (with a readable message) on any failure. */
export async function uploadFiles(threadId: string, files: readonly DraftFile[]): Promise<AttachmentRef[]> {
  if (files.length === 0) return [];
  const missing = files.filter((f) => !blobs.has(f.id));
  if (missing.length > 0) {
    throw new Error(`re-attach ${missing.map((f) => f.name).join(", ")}: file contents are not kept across reloads`);
  }
  const payload = await Promise.all(
    files.map(async (f) => ({ name: f.name, mediaType: f.mediaType, data: await readBase64(blobs.get(f.id) as File, f.name) })),
  );
  const { attachments } = await call("attachments.upload", { threadId, files: payload });
  return attachments;
}
