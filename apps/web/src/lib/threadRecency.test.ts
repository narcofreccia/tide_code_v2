import { beforeEach, describe, expect, it } from "vitest";
import { THREAD_RECENCY_CAP, recordThreadOpen, threadRecency } from "./threadRecency.ts";

describe("threadRecency", () => {
  beforeEach(() => window.localStorage.clear());

  it("records and reads open times", () => {
    recordThreadOpen("a", 5);
    recordThreadOpen("b", 9);
    expect(threadRecency()).toEqual({ a: 5, b: 9 });
  });

  it("drops the oldest beyond the cap", () => {
    for (let i = 0; i < THREAD_RECENCY_CAP + 3; i++) recordThreadOpen(`t${i}`, i + 1);
    const r = threadRecency();
    expect(Object.keys(r)).toHaveLength(THREAD_RECENCY_CAP);
    expect(r.t0).toBeUndefined();
    expect(r.t2).toBeUndefined();
    expect(r.t3).toBe(4);
  });

  it("survives corrupt storage", () => {
    window.localStorage.setItem("tide.threads.recency", "{nope");
    expect(threadRecency()).toEqual({});
  });
});
