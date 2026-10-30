import { describe, expect, it } from "vitest";
import { cpuDelta, createHostLoad, parseMeminfo, parseVmStat, type HostLoadOptions } from "./hostLoad.ts";

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            500000.
Pages inactive:                          200000.
Pages speculative:                         5000.
Pages throttled:                              0.
Pages wired down:                        100000.
Pages purgeable:                           1000.
"Translation faults":                 123456789.
`;
const MEMINFO = `MemTotal:       16000000 kB
MemFree:          500000 kB
MemAvailable:    8000000 kB
Buffers:          100000 kB
`;

type Os = NonNullable<HostLoadOptions["os"]>;
const fakeOs = (platform: string, times: { idle: number; busy: number }[][]): Os => {
  let i = 0;
  return {
    platform: () => platform as NodeJS.Platform,
    freemem: () => 111,
    totalmem: () => 64 * 2 ** 30,
    loadavg: () => [4, 0, 0],
    cpus: () => {
      const snap = times[Math.min(i++, times.length - 1)] ?? [];
      return snap.map((c) => ({ model: "x", speed: 1, times: { user: c.busy, nice: 0, sys: 0, idle: c.idle, irq: 0 } }));
    },
  };
};

describe("parsers", () => {
  it("vm_stat sums free+inactive+speculative+purgeable times page size", () => {
    expect(parseVmStat(VM_STAT)).toBe((10000 + 200000 + 5000 + 1000) * 16384);
  });
  it("vm_stat falls back to 16384 without a header, undefined without free pages", () => {
    expect(parseVmStat("Pages free: 10.\n")).toBe(10 * 16384);
    expect(parseVmStat("garbage")).toBeUndefined();
  });
  it("meminfo converts kB to bytes", () => {
    expect(parseMeminfo(MEMINFO)).toBe(8000000 * 1024);
    expect(parseMeminfo("MemFree: 1 kB")).toBeUndefined();
  });
  it("cpuDelta is busy over total", () => {
    expect(cpuDelta({ idle: 100, total: 200 }, { idle: 175, total: 300 })).toBeCloseTo(0.25);
    expect(cpuDelta({ idle: 1, total: 1 }, { idle: 1, total: 1 })).toBeUndefined();
  });
});

describe("memAvailable", () => {
  it("uses vm_stat on darwin and caches for 2s", async () => {
    let calls = 0;
    let t = 0;
    const load = createHostLoad({ os: fakeOs("darwin", [[]]), now: () => t, execFile: async () => (calls++, VM_STAT) });
    const expected = 216000 * 16384;
    expect(await load.memAvailable()).toBe(expected);
    t = 1999;
    await load.memAvailable();
    expect(calls).toBe(1);
    t = 2000;
    await load.memAvailable();
    expect(calls).toBe(2);
  });
  it("reads /proc/meminfo on linux", async () => {
    const load = createHostLoad({ os: fakeOs("linux", [[]]), readFile: async () => MEMINFO });
    expect(await load.memAvailable()).toBe(8000000 * 1024);
  });
  it("falls back to freemem when the command throws, and on other platforms", async () => {
    const boom = createHostLoad({ os: fakeOs("darwin", [[]]), execFile: async () => { throw new Error("nope"); } });
    expect(await boom.memAvailable()).toBe(111);
    expect(await createHostLoad({ os: fakeOs("win32", [[]]) }).memAvailable()).toBe(111);
  });
});

describe("cpuUsage", () => {
  it("first call uses load average, later calls the delta between snapshots, at most every 1s", () => {
    let t = 0;
    const load = createHostLoad({
      now: () => t,
      os: fakeOs("darwin", [
        [{ idle: 100, busy: 100 }, { idle: 100, busy: 100 }],
        [{ idle: 150, busy: 150 }, { idle: 250, busy: 150 }],
      ]),
    });
    expect(load.cpuUsage()).toBe(1); // loadavg 4 / 2 cores, clamped (cpus() read for core count only)
    t = 500;
    expect(load.cpuUsage()).toBe(1); // too soon: no new sample
    t = 1000;
    // idle 400-200=200? snapshot totals: prev 400, cur 700 -> total 300, idle 150+250-200=200 -> busy 100/300
    expect(load.cpuUsage()).toBeCloseTo(100 / 300);
  });
});
