import { describe, expect, it } from "vitest";
import { MAX_TRACKED_ADDRESSES, PairingCodes, RELAY_BUCKET, RELAY_PAIR_ATTEMPTS_PER_MINUTE, safeEqual } from "./pairing.ts";

describe("PairingCodes", () => {
  it("issues distinct 6-digit codes that expire after 5 minutes", () => {
    let now = 0;
    const codes = new PairingCodes({ now: () => now });
    const a = codes.issue();
    const b = codes.issue();
    expect(a.code).toMatch(/^\d{6}$/);
    expect(a.code).not.toBe(b.code);
    expect(a.expiresAt).toBe(5 * 60_000);
    now = a.expiresAt;
    expect(codes.exchange(a.code, "ip")).toBe("invalid");
  });

  it("burns outstanding codes after too many wrong guesses from many addresses", () => {
    const codes = new PairingCodes({ now: () => 0 });
    const { code } = codes.issue();
    for (let i = 0; i < 20; i++) expect(codes.exchange("999999" === code ? "888888" : "999999", `ip${i}`)).toBe("invalid");
    expect(codes.exchange(code, "fresh-ip")).toBe("invalid");
  });

  it("R19: a code carries the level it was issued with (limited by default)", () => {
    const codes = new PairingCodes({ now: () => 0 });
    const limited = codes.issue();
    const full = codes.issue({ access: "full" });
    expect(limited.access).toBe("limited");
    expect(codes.redeem(full.code, "ip")).toEqual({ outcome: "ok", access: "full" });
    expect(codes.redeem(limited.code, "ip")).toEqual({ outcome: "ok", access: "limited" });
    expect(codes.redeem(full.code, "ip")).toEqual({ outcome: "invalid" });
  });

  it("compares in constant time without throwing on length mismatch", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  it("gives relayed attempts one stricter bucket of their own", () => {
    let now = 0;
    const codes = new PairingCodes({ now: () => now });
    for (let i = 0; i < RELAY_PAIR_ATTEMPTS_PER_MINUTE; i++) expect(codes.exchange("000001", RELAY_BUCKET)).toBe("invalid");
    const { code } = codes.issue();
    expect(codes.exchange(code, RELAY_BUCKET)).toBe("rate-limited");
    // loopback and LAN addresses keep their own budget
    expect(codes.exchange("000002", "127.0.0.1")).toBe("invalid");
    now += 60_001;
    expect(codes.exchange(code, RELAY_BUCKET)).toBe("ok");
  });

  it("bounds the attempts map, evicting the least recent address", () => {
    const codes = new PairingCodes({ now: () => 0 });
    // 20 failures burn codes but the per-address map keeps growing: keep it bounded anyway
    for (let i = 0; i < MAX_TRACKED_ADDRESSES + 50; i++) codes.exchange("000001", `10.0.${i >> 8}.${i & 255}`);
    expect(codes.trackedAddresses).toBe(MAX_TRACKED_ADDRESSES);
  });
});
