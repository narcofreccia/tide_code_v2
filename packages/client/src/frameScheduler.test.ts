import { afterEach, describe, expect, it } from "vitest";
import { scheduleFrame } from "./frameScheduler.ts";

const g = globalThis as unknown as { requestAnimationFrame?: (cb: () => void) => unknown };

afterEach(() => {
  delete g.requestAnimationFrame;
});

describe("scheduleFrame", () => {
  it("runs every callback of a frame in one rAF, including ones queued while it runs", () => {
    const frames: (() => void)[] = [];
    g.requestAnimationFrame = (cb) => frames.push(cb);
    const order: string[] = [];
    scheduleFrame(() => {
      order.push("store");
      scheduleFrame(() => order.push("merge"));
    });
    scheduleFrame(() => order.push("other"));
    expect(frames).toHaveLength(1);
    frames.shift()?.();
    expect(order).toEqual(["store", "other", "merge"]);
    expect(frames).toHaveLength(0);
  });

  it("dedupes the same callback within a frame", () => {
    const frames: (() => void)[] = [];
    g.requestAnimationFrame = (cb) => frames.push(cb);
    let runs = 0;
    const cb = (): void => {
      runs += 1;
    };
    scheduleFrame(cb);
    scheduleFrame(cb);
    frames.shift()?.();
    expect(runs).toBe(1);
  });

  it("falls back to a macrotask without rAF", async () => {
    let ran = false;
    scheduleFrame(() => {
      ran = true;
    });
    expect(ran).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ran).toBe(true);
  });
});
