import { describe, expect, it } from "vitest";
import { PASTE_CHARS, PASTE_LINES, countLines, isBigPaste, pastedTextFile, MAX_FILES_BYTES, admitFiles, splitFiles } from "./attachments.ts";

const f = (id: string, bytes: number) => ({ id, name: `${id}.bin`, mediaType: "application/octet-stream", bytes });

describe("file attachment caps", () => {
  it("admits up to the byte budget and says why the rest was left out", () => {
    const out = admitFiles([f("a", MAX_FILES_BYTES - 10)], [f("b", 20), f("c", 5)]);
    expect(out.files.map((x) => x.id)).toEqual(["a", "c"]);
    expect(out.refused).toMatch(/20 MB/);
  });

  it("routes images inline only when the harness takes them", () => {
    const png = new File([""], "a.png", { type: "image/png" });
    const pdf = new File([""], "a.pdf", { type: "application/pdf" });
    expect(splitFiles([png, pdf], true)).toEqual({ images: [png], files: [pdf] });
    expect(splitFiles([png, pdf], false)).toEqual({ images: [], files: [png, pdf] });
  });
});

describe("big paste", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join("\n");
  it("trips on line or char thresholds, not below", () => {
    expect(isBigPaste(lines(PASTE_LINES - 1))).toBe(false);
    expect(isBigPaste(lines(PASTE_LINES))).toBe(true);
    expect(isBigPaste("x".repeat(PASTE_CHARS - 1))).toBe(false);
    expect(isBigPaste("x".repeat(PASTE_CHARS))).toBe(true);
  });
  it("counts lines ignoring a trailing newline", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\r\nb\r\nc")).toBe(3);
  });
  it("names the file", () => {
    const f = pastedTextFile("hi", 2);
    expect(f.name).toBe("pasted-2.txt");
    expect(f.type).toBe("text/plain");
  });
});
