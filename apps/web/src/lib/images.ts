/** The image types every harness that accepts images agrees on. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_IMAGES = 8;
/** ~5 MB per image; harnesses reject much larger payloads anyway. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface PendingImage {
  id: string;
  mediaType: string;
  /** base64 payload without the `data:` prefix */
  data: string;
  bytes: number;
  /** object URL (or data URL) for the thumbnail */
  url: string;
}

export function isSupportedImage(type: string): boolean {
  return IMAGE_TYPES.includes(type);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Thumbnail source: an object URL when the runtime has one, else the data URL. */
export function thumbnailUrl(file: Blob, mediaType: string, data: string): string {
  const create = typeof URL !== "undefined" ? URL.createObjectURL : undefined;
  return typeof create === "function" ? create(file) : `data:${mediaType};base64,${data}`;
}

export function revokeThumbnail(url: string): void {
  if (!url.startsWith("blob:")) return;
  const revoke = typeof URL !== "undefined" ? URL.revokeObjectURL : undefined;
  if (typeof revoke === "function") revoke(url);
}

/** Reads a picked/pasted/dropped image into the base64 the harness wants. */
export function readImageFile(file: File): Promise<{ mediaType: string; data: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name || "the image"}`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) {
        reject(new Error("Unreadable image data"));
        return;
      }
      resolve({ mediaType: file.type, data: result.slice(comma + 1), bytes: file.size });
    };
    reader.readAsDataURL(file);
  });
}

/** Image files carried by a paste or a drop, in order. */
export function imageFilesOf(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  const files: File[] = [];
  for (const file of Array.from(transfer.files ?? [])) {
    if (isSupportedImage(file.type)) files.push(file);
  }
  if (files.length > 0) return files;
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== "file" || !isSupportedImage(item.type)) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}
