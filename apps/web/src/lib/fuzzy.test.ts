import { describe, expect, it } from "vitest";
import { fuzzyMatch, fuzzyRank } from "./fuzzy.ts";

describe("fuzzyMatch", () => {
  it("rejects candidates missing a character", () => {
    expect(fuzzyMatch("xyz", "src/app.ts")).toBeUndefined();
  });

  it("matches a subsequence and reports positions", () => {
    expect(fuzzyMatch("apt", "src/app.ts")?.positions).toEqual([4, 5, 8]);
  });
});

describe("fuzzyRank", () => {
  const paths = [
    "src/state/workbench.ts",
    "src/components/workbench/Workbench.tsx",
    "docs/design/ui.md",
    "src/components/workbench/tree/FileTree.tsx",
  ];

  it("ranks a basename hit above a directory hit", () => {
    const ranked = fuzzyRank("workbench", paths, (p) => p);
    expect(ranked[0]?.item).toBe("src/state/workbench.ts");
  });

  it("finds a file by its initials across segments", () => {
    const ranked = fuzzyRank("filetree", paths, (p) => p);
    expect(ranked[0]?.item).toBe("src/components/workbench/tree/FileTree.tsx");
  });

  it("honours the limit", () => {
    expect(fuzzyRank("s", paths, (p) => p, 2)).toHaveLength(2);
  });
});
