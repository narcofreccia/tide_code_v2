import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createElevationVerifier, loadElevationSecret } from "./elevation.ts";

const secret = "shared UTF-8 secret ✓";
const now = 1_800_000_000;

function sign(exp: number, nonce = "0123456789abcdef", key = secret): string {
  const payload = `v1.user-42.${exp}.${nonce}`;
  return `${payload}.${createHmac("sha256", key).update(payload, "utf8").digest("hex")}`;
}

describe("MCP elevation", () => {
  it("accepts the signed token at the one-hour boundary and rejects replay", () => {
    const verify = createElevationVerifier(secret, () => now);
    const token = sign(now + 3600);
    expect(verify(token)).toEqual({ ok: true, userId: "user-42", expUnix: now + 3600 });
    expect(verify(token)).toEqual({ ok: false, reason: "replayed-nonce" });
    expect(verify(sign(now + 3600, "0123456789ABCDEF"))).toEqual({ ok: false, reason: "replayed-nonce" });
  });

  it("rejects invalid signatures, expiry and malformed tokens without consuming the nonce", () => {
    const verify = createElevationVerifier(secret, () => now);
    expect(verify(sign(now + 60, undefined, "wrong"))).toMatchObject({ ok: false, reason: "invalid-signature" });
    for (const expiry of [now - 1, now, now + 3601]) {
      expect(verify(sign(expiry))).toMatchObject({ ok: false, reason: "invalid-expiry" });
    }
    for (const token of [undefined, "", sign(now + 1, "0123"), sign(now + 0.5), `${sign(now + 60)}.extra`]) {
      expect(verify(token)).toMatchObject({ ok: false, reason: "invalid-format" });
    }
    expect(verify(sign(now + 60))).toMatchObject({ ok: true });
  });

  it("fails closed at capacity and reclaims expired entries", () => {
    let current = now;
    const verify = createElevationVerifier(secret, () => current, 1);
    expect(verify(sign(now + 1))).toMatchObject({ ok: true });
    const next = sign(now + 60, "abcdef0123456789");
    expect(verify(next)).toMatchObject({ ok: false, reason: "nonce-cache-full" });
    current++;
    expect(verify(next)).toMatchObject({ ok: true });
  });

  it("uses the configured secret or persists a private base64url key", () => {
    const dir = mkdtempSync(join(tmpdir(), "tide-mcp-key-"));
    try {
      expect(loadElevationSecret(dir, { TIDE_MCP_ELEVATION_SECRET: secret })).toBe(secret);
      const generated = loadElevationSecret(dir, {});
      expect(Buffer.from(generated, "base64url")).toHaveLength(32);
      expect(statSync(join(dir, "mcp-elevation.key")).mode & 0o777).toBe(0o600);
      expect(loadElevationSecret(dir, {})).toBe(generated);
      expect(loadElevationSecret(dir, { NODE_ENV: "test" })).not.toBe(generated);
      expect(loadElevationSecret(":memory:", {})).toMatch(/^[\w-]{43}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
