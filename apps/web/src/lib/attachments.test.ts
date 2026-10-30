import { describe, expect, it } from "vitest";
import { MAX_FILES_BYTES, admitFiles, splitFiles } from "./attachments.ts";

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
