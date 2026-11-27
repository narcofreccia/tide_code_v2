/**
 * A pasted image over the per-image cap is re-encoded smaller instead of refused: a full
 * Retina screenshot is often 6–10 MB as PNG. Harnesses downscale large images themselves
 * (Claude to ~1568px on the long edge), so a 2560px PNG — or a JPEG when even that is too
 * big — loses nothing the model would have seen.
 */
export type Encode = (file: Blob, maxEdge: number, type: string, quality?: number) => Promise<Blob | undefined>;

const STEPS: ReadonlyArray<{ edge: number; type: string; quality?: number }> = [
  { edge: 2560, type: "image/png" },
  { edge: 2560, type: "image/jpeg", quality: 0.9 },
  { edge: 1920, type: "image/jpeg", quality: 0.85 },
  { edge: 1568, type: "image/jpeg", quality: 0.8 },
];

/** The file itself when it fits; else the first re-encode under `limit`; undefined when none does. */
export async function fitImage(file: File, limit: number, encode: Encode = canvasEncode): Promise<Blob | undefined> {
  if (file.size <= limit) return file;
  for (const step of STEPS) {
    // a GIF loses its animation either way; a PNG source keeps PNG on the first try
    let out: Blob | undefined;
    try {
      out = await encode(file, step.edge, step.type, step.quality);
    } catch {
      return undefined;
    }
    if (out === undefined) return undefined;
    if (out.size <= limit) return out;
  }
  return undefined;
}

async function canvasEncode(file: Blob, maxEdge: number, type: string, quality?: number): Promise<Blob | undefined> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return undefined;
  return encodeBitmap(await createImageBitmap(file, { imageOrientation: "from-image" }), maxEdge, type, quality);
}

/** Draws the bitmap at most `maxEdge` on its long side (never upscaled) and encodes it; closes the bitmap. */
export async function encodeBitmap(bitmap: ImageBitmap, maxEdge: number, type: string, quality?: number): Promise<Blob | undefined> {
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (ctx === null) return undefined;
    if (type === "image/jpeg") {
      // JPEG has no alpha: paint transparent areas white rather than black
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | undefined>((resolve) => canvas.toBlob((b) => resolve(b ?? undefined), type, quality));
  } finally {
    bitmap.close();
  }
}
