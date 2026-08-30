import { describe, expect, it } from "vitest";
import { applyMention, expandMentions, findMentionQuery, normalizePastedPath } from "./mentions.ts";

describe("findMentionQuery", () => {
  it("finds the token the caret sits in", () => {
    expect(findMentionQuery("look at @src/a", 14)).toEqual({ start: 8, query: "src/a" });
  });

  it("ignores an @ inside a word (emails)", () => {
    expect(findMentionQuery("me@example.com", 14)).toBeUndefined();
  });

  it("stops at whitespace", () => {
    expect(findMentionQuery("@src/a and more", 15)).toBeUndefined();
  });
});

describe("applyMention", () => {
  it("replaces the partial token and returns the caret", () => {
    const mention = findMentionQuery("see @sta", 8);
    expect(mention).toBeDefined();
    expect(applyMention("see @sta", mention!, 8, "src/state/ui.ts")).toEqual({
      text: "see @src/state/ui.ts ",
      caret: 21,
    });
  });
});

describe("expandMentions", () => {
  it("wraps relative paths in backticks and leaves prose alone", () => {
    expect(expandMentions("fix @src/a.ts and @docs/b.md now")).toBe("fix `src/a.ts` and `docs/b.md` now");
  });

  it("leaves an email untouched", () => {
    expect(expandMentions("mail me@example.com")).toBe("mail me@example.com");
  });
});

describe("normalizePastedPath", () => {
  it("relativises a path inside the worktree", () => {
    expect(normalizePastedPath("/wt/t1/src/a.ts", "/wt/t1")).toBe("src/a.ts");
  });

  it("leaves paths outside the worktree alone", () => {
    expect(normalizePastedPath("/other/a.ts", "/wt/t1")).toBe("/other/a.ts");
  });
});
