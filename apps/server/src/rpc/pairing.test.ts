import { describe, expect, it } from "vitest";
import { PairingCodes, safeEqual } from "./pairing.ts";

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

  it("compares in constant time without throwing on length mismatch", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
