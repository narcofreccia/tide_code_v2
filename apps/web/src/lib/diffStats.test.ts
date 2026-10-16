import { describe, expect, it } from "vitest";
import type { DiffResult, Turn } from "@tide/contracts";
import { diffTotals, uniqueByPath } from "./diffStats.ts";

const file = (path: string, additions: number, deletions: number, status: "added" | "modified" = "modified") => ({
  path,
  status,
  additions,
  deletions,
});

const diff = (files: ReturnType<typeof file>[]): DiffResult => ({ files }) as unknown as DiffResult;

const turn = (stats?: { files: number; additions: number; deletions: number }): Turn =>
  ({ id: "u1", threadId: "t1", status: "completed", checkpoint: { before: "a", after: "b", ...(stats ? { stats } : {}) } }) as unknown as Turn;

describe("diffTotals", () => {
  it("uses the turn's checkpoint stats, the figure the turn list shows", () => {
    const totals = diffTotals(turn({ files: 0, additions: 0, deletions: 0 }), diff([file("hello.md", 1, 1)]));
    expect(totals).toEqual({ additions: 0, deletions: 0, files: 0 });
  });

  it("sums the diff over unique paths when there are no stats (whole thread)", () => {
    const totals = diffTotals(undefined, diff([file("hello.md", 0, 1), file("hello.md", 1, 0, "added"), file("b.ts", 2, 3)]));
    expect(totals).toEqual({ additions: 3, deletions: 3, files: 2 });
  });

  it("is undefined with neither stats nor a diff", () => {
    expect(diffTotals(turn(), undefined)).toBeUndefined();
  });

  it("keeps the last entry per path", () => {
    expect(uniqueByPath([file("a", 1, 0), file("a", 2, 0)])).toEqual([file("a", 2, 0)]);
  });
});
