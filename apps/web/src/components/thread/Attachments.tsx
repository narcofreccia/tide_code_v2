import { useCallback, useRef, useState } from "react";
import type { SerializedImage } from "../../state/drafts.ts";
import { errorText } from "../../lib/dispatchOrToast.ts";
import { showToast } from "../../state/toast.ts";
import {
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  formatBytes,
  readImageFile,
  revokeThumbnail,
  thumbnailUrl,
  type PendingImage,
} from "../../lib/images.ts";
import { Icon } from "../ui/Icon.tsx";
import styles from "./Attachments.module.css";

export interface Attachments {
  images: PendingImage[];
  add: (files: File[]) => Promise<void>;
  remove: (id: string) => void;
  clear: () => void;
  /** swaps the whole list, e.g. when a draft is restored or a stash applied */
  replace: (images: SerializedImage[]) => void;
}

export function serializeImages(images: PendingImage[]): SerializedImage[] {
  return images.map(({ id, mediaType, data, bytes }) => ({ id, mediaType, data, bytes }));
}

export function deserializeImages(images: SerializedImage[]): PendingImage[] {
  return images.map((i) => ({ ...i, url: `data:${i.mediaType};base64,${i.data}` }));
}

/** The composer's pending image list: reads files to base64 and caps the set. */
export function useAttachments(): Attachments {
  const [images, setImages] = useState<PendingImage[]>([]);
  const current = useRef<PendingImage[]>([]);
  const nextId = useRef(1);

  const commit = (next: PendingImage[]): void => {
    current.current = next;
    setImages(next);
  };

  const freshId = (): string => {
    // restored drafts bring their own ids: never reuse one
    while (current.current.some((image) => image.id === `img-${nextId.current}`)) nextId.current++;
    return `img-${nextId.current++}`;
  };

  const add = useCallback(async (files: File[]): Promise<void> => {
    for (const file of files) {
      if (current.current.length >= MAX_IMAGES) {
        showToast(`At most ${MAX_IMAGES} images per message`);
        break;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        showToast(`${file.name || "Image"} is larger than ${formatBytes(MAX_IMAGE_BYTES)}`);
        continue;
      }
      try {
        const read = await readImageFile(file);
        commit([
          ...current.current,
          {
            id: freshId(),
            mediaType: read.mediaType,
            data: read.data,
            bytes: read.bytes,
            url: thumbnailUrl(file, read.mediaType, read.data),
          },
        ]);
      } catch (error: unknown) {
        showToast(errorText(error));
      }
    }
  }, []);

  const remove = useCallback((id: string): void => {
    const gone = current.current.find((image) => image.id === id);
    if (gone) revokeThumbnail(gone.url);
    commit(current.current.filter((image) => image.id !== id));
  }, []);

  const clear = useCallback((): void => {
    for (const image of current.current) revokeThumbnail(image.url);
    commit([]);
  }, []);

  const replace = useCallback((next: SerializedImage[]): void => {
    for (const image of current.current) revokeThumbnail(image.url);
    commit(deserializeImages(next));
  }, []);

  return { images, add, remove, clear, replace };
}

/** Thumbnails of the images that will ride along with the next prompt. */
export function AttachmentStrip({ images, onRemove }: { images: PendingImage[]; onRemove: (id: string) => void }) {
  if (images.length === 0) return null;
  return (
    <ul className={styles.strip} aria-label="Attached images">
      {images.map((image) => (
        <li key={image.id} className={styles.item}>
          <img className={styles.thumb} src={image.url} alt={`${image.mediaType} attachment`} />
          <span className={styles.meta}>{formatBytes(image.bytes)}</span>
          <button
            type="button"
            className={styles.remove}
            aria-label={`Remove attachment ${image.id}`}
            onClick={() => onRemove(image.id)}
          >
            <Icon name="close" size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}
