import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DomainEvent, ImageBlob, ImageInput, StoredImage } from "@tide/contracts";

/**
 * R24: pasted image bytes live in a content-addressed directory instead of the event log.
 * Before R24 every `turn.requested` carried its images as base64, so the log grew by MBs per
 * paste and every subscriber received those MBs over the socket. The engine now swaps the bytes
 * for a `blob` id before appending; the reactor swaps them back when it hands a turn to a harness.
 * Old events keep their inline bytes and still work.
 */
export interface ImageBlobs {
  /** writes the bytes (once per content) and returns the references to record */
  stash(images: readonly StoredImage[]): StoredImage[];
  /** the bytes again; a blob that is gone is dropped (logged) rather than failing the turn */
  load(images: readonly StoredImage[] | undefined): ImageInput[] | undefined;
}

const isBlob = (image: StoredImage): image is ImageBlob => "blob" in image;

export function createImageBlobs(dir: string, log: (msg: string, data?: unknown) => void = () => undefined): ImageBlobs {
  let made = false;
  const pathOf = (blob: string): string => join(dir, blob.slice(0, 2), blob);
  return {
    stash(images) {
      return images.map((image) => {
        if (isBlob(image)) return image;
        const bytes = Buffer.from(image.data, "base64");
        const blob = createHash("sha256").update(bytes).digest("hex");
        const path = pathOf(blob);
        if (!existsSync(path)) {
          if (!made) {
            mkdirSync(dir, { recursive: true });
            made = true;
          }
          mkdirSync(join(dir, blob.slice(0, 2)), { recursive: true });
          // write-then-rename: a crash never leaves a truncated blob under its final name
          const tmp = `${path}.${process.pid}.tmp`;
          writeFileSync(tmp, bytes);
          renameSync(tmp, path);
        }
        return { mediaType: image.mediaType, blob };
      });
    },
    load(images) {
      if (images === undefined) return undefined;
      const out: ImageInput[] = [];
      for (const image of images) {
        if (!isBlob(image)) {
          out.push(image);
          continue;
        }
        try {
          out.push({ mediaType: image.mediaType, data: readFileSync(pathOf(image.blob)).toString("base64") });
        } catch (err) {
          log(`[images] blob ${image.blob} is missing; the turn goes without it`, err);
        }
      }
      return out;
    },
  };
}

/** The event with its image bytes swapped for blob references (same object when it has none). */
export function stashEventImages(event: DomainEvent, blobs: Pick<ImageBlobs, "stash">): DomainEvent {
  if (event.type !== "turn.requested" && event.type !== "turn.steered" && event.type !== "turn.steer-fell-back") return event;
  if (event.images === undefined || event.images.length === 0) return event;
  return { ...event, images: blobs.stash(event.images) };
}
