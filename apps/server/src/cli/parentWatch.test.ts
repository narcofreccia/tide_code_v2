import { describe, expect, it } from "vitest";
import { parentPidFrom, watchParent, type ParentWatchDeps } from "./parentWatch.ts";

function fakeHost(parent: number) {
  const state = { alive: true, ppid: parent, ms: 0, stopped: false, tick: (): void => {} };
  const deps: ParentWatchDeps = {
    alive: () => state.alive,
    ppid: () => state.ppid,
    every: (fn, ms) => {
      state.tick = fn;
      state.ms = ms;
      return () => {
        state.stopped = true;
      };
    },
  };
  return { state, deps };
}

describe("watchParent", () => {
  it("fires once when the parent pid disappears", () => {
    const { state, deps } = fakeHost(100);
    const reasons: string[] = [];
    watchParent(100, (r) => reasons.push(r), deps, 2_000);
    expect(state.ms).toBe(2_000);
    state.tick();
    expect(reasons).toEqual([]);
    state.alive = false;
    state.tick();
    state.tick();
    expect(reasons).toEqual(["parent process 100 exited"]);
    expect(state.stopped).toBe(true);
  });

  it("fires when a direct child is re-parented even if the pid was recycled", () => {
    const { state, deps } = fakeHost(100);
    const reasons: string[] = [];
    watchParent(100, (r) => reasons.push(r), deps);
    state.ppid = 1;
    state.tick();
    expect(reasons).toEqual(["re-parented away from 100"]);
  });

  it("ignores the ppid when the watched pid was never our direct parent", () => {
    const { state, deps } = fakeHost(55);
    const reasons: string[] = [];
    watchParent(100, (r) => reasons.push(r), deps);
    state.ppid = 1;
    state.tick();
    expect(reasons).toEqual([]);
  });

  it("stops quietly when cancelled", () => {
    const { state, deps } = fakeHost(100);
    const reasons: string[] = [];
    const cancel = watchParent(100, (r) => reasons.push(r), deps);
    cancel();
    state.alive = false;
    state.tick();
    expect(reasons).toEqual([]);
    expect(state.stopped).toBe(true);
  });
});

describe("parentPidFrom", () => {
  it("accepts a positive pid and rejects junk, init and ourselves", () => {
    expect(parentPidFrom({ TIDE_PARENT_PID: "1234" })).toBe(1234);
    expect(parentPidFrom({})).toBeUndefined();
    expect(parentPidFrom({ TIDE_PARENT_PID: "abc" })).toBeUndefined();
    expect(parentPidFrom({ TIDE_PARENT_PID: "1" })).toBeUndefined();
    expect(parentPidFrom({ TIDE_PARENT_PID: String(process.pid) })).toBeUndefined();
  });
});
