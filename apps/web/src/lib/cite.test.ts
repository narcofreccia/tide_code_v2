import { describe, expect, it } from "vitest";
import { applyCompose, citeBlock, readComposeDetail, CITE_LIMIT } from "./cite.ts";

describe("cite", () => {
  it("quotes every line, trims to the limit and names the source", () => {
    expect(citeBlock("  one\n\ntwo ", "turn 1")).toBe("> one\n>\n> two\n— from turn 1\n\n");
    const long = citeBlock("x".repeat(CITE_LIMIT + 50), undefined);
    expect(long.length).toBeLessThanOrEqual(CITE_LIMIT + 6);
  });

  it("reads both compose event shapes", () => {
    expect(readComposeDetail("hi")).toEqual({ text: "hi", mode: "replace" });
    expect(readComposeDetail({ text: "q", mode: "append" })).toEqual({ text: "q", mode: "append" });
    expect(readComposeDetail(3)).toBeUndefined();
    expect(applyCompose("a  ", { text: "b", mode: "append" })).toBe("a\n\nb");
    expect(applyCompose("", { text: "b", mode: "append" })).toBe("b");
  });
});
