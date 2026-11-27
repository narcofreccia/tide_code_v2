import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ELEVATION_HEADER = "x-tide-elevation-token";
export const ELEVATION_REQUIRED = "ELEVATION_REQUIRED: Unlock 2FA Full-Access in Tide AI Chat to use full-access mode.";

export function loadElevationSecret(dataDir: string, env = process.env): string {
  if (env.TIDE_MCP_ELEVATION_SECRET) return env.TIDE_MCP_ELEVATION_SECRET;
  const generated = randomBytes(32).toString("base64url");
  if (dataDir === ":memory:" || env.NODE_ENV === "test") return generated;

  const path = join(dataDir, "mcp-elevation.key");
  try {
    writeFileSync(path, generated, { mode: 0o600, flag: "wx" });
    return generated;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const secret = readFileSync(path, "utf8").trim();
    if (!secret) throw new Error("mcp-elevation.key is empty");
    return secret;
  }
}

export type ElevationResult = { ok: true; userId: string; expUnix: number } | { ok: false; reason: string };

export function createElevationVerifier(secret: string, now = () => Math.floor(Date.now() / 1000), capacity = 4096) {
  const used = new Map<string, number>();
  return (token: string | undefined): ElevationResult => {
    const parts = token?.split(".");
    const [version, userId, expiry, nonce, sig] = parts ?? [];
    if (parts?.length !== 5 || version !== "v1" || !userId || !expiry || !/^\d+$/.test(expiry) ||
        !nonce || !/^[0-9a-f]{16,64}$/i.test(nonce) || !sig || !/^[0-9a-f]{64}$/.test(sig)) {
      return { ok: false, reason: "invalid-format" };
    }

    const expUnix = Number(expiry);
    const current = now();
    if (!Number.isSafeInteger(expUnix) || expUnix <= current || expUnix - current > 3600) {
      return { ok: false, reason: "invalid-expiry" };
    }
    const expected = createHmac("sha256", secret).update(parts.slice(0, 4).join("."), "utf8").digest("hex");
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return { ok: false, reason: "invalid-signature" };

    for (const [key, expires] of used) if (expires <= current) used.delete(key);
    const key = nonce.toLowerCase();
    if (used.has(key)) return { ok: false, reason: "replayed-nonce" };
    if (used.size >= capacity) return { ok: false, reason: "nonce-cache-full" };
    used.set(key, expUnix);
    return { ok: true, userId, expUnix };
  };
}
