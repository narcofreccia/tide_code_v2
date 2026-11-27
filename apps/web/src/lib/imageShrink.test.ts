import { describe, expect, it } from "vitest";
import { fitImage, type Encode } from "./imageShrink.ts";

const file = (size: number, type = "image/png"): File => new File([new Uint8Array(size)], "shot.png", { type });

describe("fitImage", () => {
  it("returns a file under the limit untouched, without encoding", async () => {
    const small = file(10);
    const encode: Encode = () => Promise.reject(new Error("should not encode"));
    expect(await fitImage(small, 100, encode)).toBe(small);
  });

  it("walks down the steps until one fits", async () => {
    const calls: string[] = [];
    const encode: Encode = async (_f, edge, type) => {
      calls.push(`${edge}:${type}`);
      return new Blob([new Uint8Array(edge === 1920 ? 50 : 500)], { type });
    };
    const out = await fitImage(file(1000), 100, encode);
    expect(out?.size).toBe(50);
    expect(out?.type).toBe("image/jpeg");
    expect(calls).toEqual(["2560:image/png", "2560:image/jpeg", "1920:image/jpeg"]);
  });

  it("gives up when nothing fits or the image cannot be decoded", async () => {
    const big: Encode = async (_f, _e, type) => new Blob([new Uint8Array(500)], { type });
    expect(await fitImage(file(1000), 100, big)).toBeUndefined();
    expect(await fitImage(file(1000), 100, () => Promise.reject(new Error("decode")))).toBeUndefined();
    expect(await fitImage(file(1000), 100, async () => undefined)).toBeUndefined();
  });
});
