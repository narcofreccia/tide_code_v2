import { describe, expect, it } from "vitest";
import { applyCompose, citeBlock, composeIsFor, readComposeDetail, CITE_LIMIT } from "./cite.ts";

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

  it("R16: scopes a compose to one thread's composer", () => {
    expect(readComposeDetail({ text: "q", mode: "append", threadId: "t2" })).toEqual({ text: "q", mode: "append", threadId: "t2" });
    expect(readComposeDetail({ text: "q", threadId: 4 })).toEqual({ text: "q", mode: "replace" });
    const scoped = { text: "q", mode: "append" as const, threadId: "t2" };
    expect(composeIsFor(scoped, "t2", false)).toBe(true);
    expect(composeIsFor(scoped, "t1", true)).toBe(false);
    expect(composeIsFor({ text: "q", mode: "replace" }, "t1", true)).toBe(true);
    expect(composeIsFor({ text: "q", mode: "replace" }, "s1", false)).toBe(false);
  });
});
