import { describe, expect, it } from "vitest";
import { formatBytes, imageFilesOf, isSupportedImage, readImageFile } from "./images.ts";

const png = (name = "a.png", type = "image/png"): File =>
  new File([new Uint8Array([1, 2, 3, 4])], name, { type });

describe("images", () => {
  it("accepts only the types every harness understands", () => {
    expect(isSupportedImage("image/png")).toBe(true);
    expect(isSupportedImage("image/svg+xml")).toBe(false);
    expect(isSupportedImage("text/plain")).toBe(false);
  });

  it("formats sizes the way the pills read", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(122880)).toBe("120 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("picks image files out of a transfer, files first then items", () => {
    const dropped = png("dropped.png");
    const pasted = png("pasted.png");
    expect(
      imageFilesOf({ files: [dropped, new File([""], "n.txt", { type: "text/plain" })] } as unknown as DataTransfer),
    ).toEqual([dropped]);
    expect(
      imageFilesOf({
        files: [],
        items: [{ kind: "file", type: "image/png", getAsFile: () => pasted }],
      } as unknown as DataTransfer),
    ).toEqual([pasted]);
    expect(imageFilesOf(null)).toEqual([]);
  });

  it("reads a file into bare base64", async () => {
    const read = await readImageFile(png());
    expect(read.mediaType).toBe("image/png");
    expect(read.bytes).toBe(4);
    expect(read.data).not.toContain("base64,");
    expect(read.data.length).toBeGreaterThan(0);
  });
});
