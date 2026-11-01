import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireHomeLock, HomeInUseError, lockFileOf, readLock, releaseHomeLock, updateHomeLock, type LockInfo, type LockProbes } from "./homeLock.ts";

const ENV = "env-1";
const me: LockInfo = { pid: process.pid, port: 4000, startedAt: 1, version: "1.0.0" };
const other: LockInfo = { pid: 424242, port: 5000, startedAt: 0, version: "0.9.0" };

function probes(over: Partial<{ alive: boolean; health: string | undefined }> = {}): LockProbes & { healthCalls: number[] } {
  const healthCalls: number[] = [];
  return {
    healthCalls,
    alive: () => over.alive ?? true,
    health: async (port) => {
      healthCalls.push(port);
      return "health" in over ? over.health : ENV;
    },
  };
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tide-lock-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const plant = (info: LockInfo): void => writeFileSync(lockFileOf(home), JSON.stringify(info));

describe("home lock", () => {
  it("acquires a fresh home", async () => {
    const p = probes();
    await acquireHomeLock(home, me, ENV, p);
    expect(readLock(home)).toEqual(me);
    expect(p.healthCalls).toEqual([]);
  });

  it("refuses while a live holder answers /health with this home's environment", async () => {
    plant(other);
    const p = probes();
    const err = await acquireHomeLock(home, me, ENV, p).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HomeInUseError);
    expect((err as HomeInUseError).message).toContain("pid 424242, port 5000, version 0.9.0");
    expect(p.healthCalls).toEqual([5000]);
    expect(readLock(home)).toEqual(other);
  });

  it("accepts the holder's recorded environment id (a copied store keeps its own)", async () => {
    plant({ ...other, environmentId: "copied" });
    await expect(acquireHomeLock(home, me, ENV, probes({ health: "copied" }))).rejects.toBeInstanceOf(HomeInUseError);
  });

  it("takes over when the holder's pid is dead", async () => {
    plant(other);
    const p = probes({ alive: false });
    await acquireHomeLock(home, me, ENV, p);
    expect(readLock(home)).toEqual(me);
    expect(p.healthCalls).toEqual([]);
  });

  it("takes over when the holder is alive but does not answer", async () => {
    plant(other);
    await acquireHomeLock(home, me, ENV, probes({ health: undefined }));
    expect(readLock(home)).toEqual(me);
  });

  it("takes over when the pid now belongs to a server of another home", async () => {
    plant(other);
    await acquireHomeLock(home, me, ENV, probes({ health: "someone-else" }));
    expect(readLock(home)?.pid).toBe(me.pid);
  });

  it("takes over an unreadable lock", async () => {
    writeFileSync(lockFileOf(home), "{half");
    await acquireHomeLock(home, me, ENV, probes());
    expect(readLock(home)).toEqual(me);
  });

  it("updates and releases only its own lock", async () => {
    await acquireHomeLock(home, me, ENV, probes());
    updateHomeLock(home, { ...me, port: 4100, environmentId: ENV });
    expect(readLock(home)).toEqual({ ...me, port: 4100, environmentId: ENV });

    releaseHomeLock(home, other.pid);
    expect(readLock(home)?.pid).toBe(me.pid);
    releaseHomeLock(home, me.pid);
    expect(readLock(home)).toBeUndefined();
  });

  it("leaves a lock taken over by another server alone", async () => {
    await acquireHomeLock(home, me, ENV, probes());
    plant(other); // another server took over while we were wedged
    updateHomeLock(home, { ...me, port: 1 });
    releaseHomeLock(home, me.pid);
    expect(readLock(home)).toEqual(other);
  });
});
