import { describe, expect, it } from "vitest";
import {
  applyMention,
  expandMentions,
  expandThreadMentions,
  findMentionQuery,
  insertAt,
  normalizePastedPath,
  removeThreadMention,
  threadMentionIds,
} from "./mentions.ts";

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

describe("thread mentions", () => {
  it("leaves @thread tokens out of the path backticks", () => {
    expect(expandMentions("see @thread:01ABC and @src/a.ts")).toBe("see @thread:01ABC and `src/a.ts`");
  });

  it("lists, removes and expands thread mentions", () => {
    const text = "@thread:a vs @thread:b, again @thread:a";
    expect(threadMentionIds(text)).toEqual(["a", "b"]);
    expect(removeThreadMention(text, "a")).toBe("vs @thread:b, again ");
    expect(expandThreadMentions("why @thread:a", (id) => (id === "a" ? "Auth" : undefined))).toBe(
      'why "Auth"\n\nContext thread "Auth" (id a): read it with the tide_thread_read tool before answering.',
    );
  });

  it("inserts a token at the caret with spacing", () => {
    expect(insertAt("ab", 1, "@thread:x")).toEqual({ text: "a @thread:x b", caret: 12 });
    expect(insertAt("", 0, "@thread:x")).toEqual({ text: "@thread:x ", caret: 10 });
  });
});
