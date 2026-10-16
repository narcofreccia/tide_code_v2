import { describe, expect, it } from "vitest";
import { contentLines, diffView } from "./diffSides.ts";

describe("diffView", () => {
  it("renders a new file as added lines only, with no removed line", () => {
    const view = diffView({ status: "added" }, "", "one\ntwo\n");
    expect(view).toEqual({
      kind: "oneSided",
      lines: [
        { kind: "add", text: "+one" },
        { kind: "add", text: "+two" },
      ],
    });
    if (view.kind === "oneSided") expect(view.lines.some((l) => l.kind === "del")).toBe(false);
  });

  it("gives a new file an empty before text with no lines", () => {
    const view = diffView({ status: "added" }, "stale", "x");
    expect(view.kind).toBe("oneSided");
    expect(contentLines("")).toEqual([]);
  });

  it("renders a deleted file as removed lines only", () => {
    const view = diffView({ status: "deleted" }, "a\nb", "");
    expect(view).toEqual({
      kind: "oneSided",
      lines: [
        { kind: "del", text: "-a" },
        { kind: "del", text: "-b" },
      ],
    });
  });

  it("keeps both sides for a modified file", () => {
    expect(diffView({ status: "modified" }, "a\n", "b\n")).toEqual({ kind: "sides", original: "a\n", modified: "b\n" });
  });

  it("keeps sides for an added empty file (nothing to show on either side)", () => {
    expect(diffView({ status: "added" }, "", "")).toEqual({ kind: "sides", original: "", modified: "" });
  });
});
