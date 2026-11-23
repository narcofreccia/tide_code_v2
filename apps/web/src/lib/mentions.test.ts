import { describe, expect, it } from "vitest";
import {
  applyMention,
  delegateMention,
  delegateMentionIds,
  expandDelegateMentions,
  removeDelegateMention,
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
  it("replaces the partial token and quotes paths with spaces", () => {
    const mention = findMentionQuery("see @sta", 8);
    expect(mention).toBeDefined();
    expect(applyMention("see @sta", mention!, 8, "src/state/ui.ts")).toEqual({
      text: "see @src/state/ui.ts ",
      caret: 21,
    });
    const spaced = findMentionQuery("see @my", 7);
    expect(applyMention("see @my", spaced!, 7, "my folder/a.ts")).toEqual({
      text: 'see @"my folder/a.ts" ',
      caret: 22,
    });
  });
});

describe("expandMentions", () => {
  it("wraps relative paths and quoted spaced paths in backticks and leaves prose alone", () => {
    expect(expandMentions("fix @src/a.ts and @docs/b.md now")).toBe("fix `src/a.ts` and `docs/b.md` now");
    expect(expandMentions('open @"my folder/a.ts" please')).toBe("open `my folder/a.ts` please");
  });

  it("leaves emails, scoped npm packages, decorators, and handles untouched", () => {
    expect(expandMentions("mail me@example.com")).toBe("mail me@example.com");
    expect(expandMentions("check @tide/server and @types/node with @dataclass for @alice")).toBe(
      "check @tide/server and @types/node with @dataclass for @alice",
    );
  });

  it("expands extensionless repo files when knownPaths contains them", () => {
    const known = new Set(["Makefile", "src/a.ts"]);
    expect(expandMentions("run @Makefile and check @tide/server", known)).toBe("run `Makefile` and check @tide/server");
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

describe("@delegate mentions", () => {
  const labelOf = (id: string) =>
    id === "codex" ? { label: "Codex", kind: "codex" as const } : id === "codex-work" ? { label: "Codex · work", kind: "codex" as const } : undefined;

  it("builds and parses tokens", () => {
    expect(delegateMention("codex")).toBe("@delegate:codex");
    expect(delegateMention("opencode", "zai/glm-4.6")).toBe("@delegate:opencode/zai/glm-4.6");
    expect(delegateMentionIds("a @delegate:codex/gpt-5.1 b @delegate:codex/gpt-5.1 @delegate:codex-work")).toEqual([
      { providerId: "codex", model: "gpt-5.1" },
      { providerId: "codex-work" },
    ]);
    expect(delegateMentionIds("mail@delegate:codex")).toEqual([]);
  });

  it("is not treated as a file mention", () => {
    expect(expandMentions("@delegate:codex/gpt-5 @src/a.ts")).toBe("@delegate:codex/gpt-5 `src/a.ts`");
  });

  it("expands in place and appends one line per target", () => {
    expect(expandDelegateMentions("have @delegate:codex/gpt-5 review it, @delegate:codex/gpt-5 again", labelOf)).toBe(
      'have Codex (gpt-5) review it, Codex (gpt-5) again\n\nDelegate to: use tide_delegate with provider "codex", providerId "codex", model "gpt-5" for the part of this request addressed to it.',
    );
    const two = expandDelegateMentions("@delegate:codex-work and @delegate:codex", labelOf);
    expect(two).toContain("Codex · work and Codex\n\n");
    expect(two.split("\n").filter((l) => l.startsWith("Delegate to:"))).toHaveLength(2);
    expect(two).toContain('providerId "codex-work"');
  });

  it("leaves text without tokens alone and survives unknown ids", () => {
    expect(expandDelegateMentions("plain", labelOf)).toBe("plain");
    expect(expandDelegateMentions("@delegate:gone", labelOf)).toContain('provider "gone", providerId "gone"');
  });

  it("removes a token and its trailing space", () => {
    expect(removeDelegateMention("a @delegate:opencode/zai/glm-4.6 b", { providerId: "opencode", model: "zai/glm-4.6" })).toBe("a b");
    expect(removeDelegateMention("@delegate:codex x @delegate:codex/m", { providerId: "codex" })).toBe("x @delegate:codex/m");
  });
});
