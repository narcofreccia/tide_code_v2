/**
 * HEIC/HEIF (iPhone photos) → JPEG in the browser, before the image is attached. No harness
 * accepts HEIC, so before this a dropped photo went to the agent as a file path it could not read.
 * WebKit (the macOS shell, Safari) decodes HEIC natively; elsewhere (Windows WebView2, Chrome)
 * the `heic-to` wasm decoder (~3 MB, LGPL-3.0) is loaded on demand into its own chunk.
 * Ported from tide_frontend's media library.
 */
import { encodeBitmap } from "./imageShrink.ts";

/** Same long edge as the oversize fallback: harnesses downscale beyond it anyway. */
const MAX_EDGE = 2560;
const QUALITY = 0.85;
const HEIC_EXT = /\.(heic|heif)$/i;

let decoder: Promise<typeof import("heic-to/csp")> | undefined;
function loadDecoder(): Promise<typeof import("heic-to/csp")> {
  decoder ??= import("heic-to/csp").catch((err: unknown) => {
    decoder = undefined; // a later photo may retry
    throw err;
  });
  return decoder;
}

async function decode(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" }); // WebKit: native HEIC
  } catch {
    const { heicTo } = await loadDecoder();
    return heicTo({ blob: file, type: "bitmap", options: { imageOrientation: "from-image" } });
  }
}

/** "IMG_0412.HEIC" → "IMG_0412.jpg" (image/jpeg), long side ≤ 2560. Throws when it cannot decode. */
export async function convertHeic(file: File): Promise<File> {
  const blob = await encodeBitmap(await decode(file), MAX_EDGE, "image/jpeg", QUALITY);
  if (blob === undefined) throw new Error(`Could not convert ${file.name || "the photo"}`);
  const base = file.name.replace(HEIC_EXT, "") || "photo";
  return new File([blob], `${base}.jpg`, { type: "image/jpeg", lastModified: file.lastModified });
}
