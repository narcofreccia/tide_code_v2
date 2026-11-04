import { describe, expect, it } from "vitest";
import { isImagePath } from "./imagePaths.ts";

describe("isImagePath", () => {
  it("matches image extensions case-insensitively", () => {
    for (const p of ["a.png", "d/A.JPG", "x.jpeg", "x.gif", "x.webp", "x.svg", "x.bmp", "x.ico", "x.avif"]) {
      expect(isImagePath(p)).toBe(true);
    }
  });
  it("rejects others", () => {
    for (const p of ["a.pdf", "png", "dir.png/file", ".png", "a.ts"]) expect(isImagePath(p)).toBe(false);
  });
});
