import { afterEach, describe, expect, it } from "vitest";
import { SCROLL_MEMORY_LIMIT, forgetAllScroll, recallScroll, rememberScroll } from "./scrollMemory.ts";

afterEach(forgetAllScroll);

const at = (entryId: string) => ({ entryId, offsetWithinEntry: 4, atEnd: false });

describe("scrollMemory", () => {
  it("returns the last position saved for a thread", () => {
    rememberScroll("t1", at("3"));
    rememberScroll("t1", at("5"));
    expect(recallScroll("t1")).toEqual(at("5"));
    expect(recallScroll("t2")).toBeUndefined();
  });

  it("evicts the least recently saved thread past the limit", () => {
    for (let i = 0; i < SCROLL_MEMORY_LIMIT; i++) rememberScroll(`t${i}`, at("0"));
    rememberScroll("t0", at("1")); // t0 is now the most recent
    rememberScroll("extra", at("2"));
    expect(recallScroll("t0")).toEqual(at("1"));
    expect(recallScroll("t1")).toBeUndefined();
    expect(recallScroll("extra")).toEqual(at("2"));
  });
});
