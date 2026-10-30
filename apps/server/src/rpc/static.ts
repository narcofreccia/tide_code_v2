import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

export function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

async function fileIn(root: string, path: string): Promise<string | undefined> {
  try {
    const real = await realpath(path);
    if (real !== root && !real.startsWith(root + sep)) return undefined; // symlink out of the web root
    return (await stat(real)).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Serves the built web client from `root`: exact files with their MIME type, never a directory
 * listing, and `index.html` for any other GET so client-side routes survive a reload. Hashed
 * assets are cached for a year; index.html never, so an upgrade is picked up at once.
 * Returns false when the request is not one it answers (non-GET, or a missing `/assets/…` file).
 */
export async function serveStatic(root: string, method: string, pathname: string, res: ServerResponse): Promise<boolean> {
  if (method !== "GET" && method !== "HEAD") return false;
  const realRoot = await realpath(root).catch(() => undefined);
  if (realRoot === undefined) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (decoded.includes("\0")) return false;
  const candidate = resolve(realRoot, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  let file = candidate.startsWith(realRoot + sep) ? await fileIn(realRoot, candidate) : undefined;
  if (file === undefined) {
    // a missing asset is a real 404 (a stale tab asking for an old hash must not get HTML as JS)
    if (decoded.startsWith("/assets/") || extname(decoded) !== "") return false;
    file = await fileIn(realRoot, join(realRoot, "index.html"));
    if (file === undefined) return false;
  }
  const isIndex = file === join(realRoot, "index.html");
  res.writeHead(200, {
    "content-type": mimeOf(file),
    "cache-control": isIndex ? "no-cache" : file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "public, max-age=300",
    "x-content-type-options": "nosniff",
  });
  if (method === "HEAD") {
    res.end();
    return true;
  }
  await new Promise<void>((done) => {
    const stream = createReadStream(file);
    stream.on("error", () => {
      res.destroy();
      done();
    });
    stream.on("end", () => done());
    stream.pipe(res);
  });
  return true;
}
