import { describe, expect, it } from "vitest";
import { FLIP_CAP, flipDeltas, parseDuration, type RowPos } from "./railMotion.ts";

const at = (entries: [string, number, number?][]): Map<string, RowPos> =>
  new Map(entries.map(([id, top, left = 0]) => [id, { top, left }]));

describe("flipDeltas", () => {
  it("offsets each moved row from its new place back to its old one", () => {
    const before = at([["a", 0], ["b", 28], ["c", 56]]);
    const after = at([["c", 0], ["a", 28], ["b", 56]]);
    expect(flipDeltas(before, after)).toEqual({
      moved: [
        { id: "c", dx: 0, dy: 56 },
        { id: "a", dx: 0, dy: -28 },
        { id: "b", dx: 0, dy: -28 },
      ],
      entered: [],
    });
  });

  it("ignores sub-pixel jitter and rows that left, and reports new rows", () => {
    const before = at([["a", 0], ["gone", 28], ["b", 56]]);
    const after = at([["a", 0.3], ["n", 28], ["b", 56]]);
    const out = flipDeltas(before, after);
    expect(out.entered).toEqual(["n"]);
    expect(out.moved).toEqual([]);
  });

  it("animates nothing on the first measure", () => {
    expect(flipDeltas(undefined, at([["a", 0]]))).toEqual({ moved: [], entered: [] });
    expect(flipDeltas(new Map(), at([["a", 0]]))).toEqual({ moved: [], entered: [] });
  });

  it("caps the rows animated in one update", () => {
    const n = FLIP_CAP + 10;
    const before = at(Array.from({ length: n }, (_, i): [string, number] => [`r${i}`, i * 28]));
    const after = at(Array.from({ length: n }, (_, i): [string, number] => [`r${i}`, (i + 1) * 28]));
    const out = flipDeltas(before, after);
    expect(out.moved.length).toBe(FLIP_CAP);
    expect(out.moved[0]).toEqual({ id: "r0", dx: 0, dy: -28 });
  });

  it("parses CSS durations", () => {
    expect(parseDuration(" 200ms")).toBe(200);
    expect(parseDuration("0.2s")).toBe(200);
    expect(parseDuration("0ms")).toBe(0);
    expect(parseDuration("")).toBe(0);
  });
});
