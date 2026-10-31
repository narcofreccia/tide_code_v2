import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PtyChunk } from "@tide/contracts";
import { isBunRuntime } from "./bunBackend.ts";
import { PtyManager } from "./manager.ts";
import { fakeBackend } from "./fakeBackend.ts";
import { descendants, killProcessTree, type TreeSignal } from "./killTree.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** Collects chunks and lets a test await a predicate instead of sleeping. */
class Sink {
  readonly chunks: PtyChunk[] = [];
  #waiters: { match: (c: PtyChunk, all: PtyChunk[]) => boolean; resolve: () => void }[] = [];

  readonly emit = (chunk: PtyChunk): void => {
    this.chunks.push(chunk);
    this.#waiters = this.#waiters.filter((w) => {
      if (!w.match(chunk, this.chunks)) return true;
      w.resolve();
      return false;
    });
  };

  get text(): string {
    return this.chunks.map((c) => (c.kind === "data" ? c.data : "")).join("");
  }

  await(match: (c: PtyChunk, all: PtyChunk[]) => boolean): Promise<void> {
    if (this.chunks.some((c) => match(c, this.chunks))) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push({ match, resolve }));
  }
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tide-pty-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("PtyManager (node-pty)", () => {
  it("runs a command, replays scrollback on re-attach and reports exit", async () => {
    const cwd = await tempDir();
    const ptys = new PtyManager();
    cleanups.push(() => ptys.closeAll());

    const ptyId = await ptys.create("th-1", cwd, 80, 24, "/bin/sh");
    const first = new Sink();
    const detach = ptys.attach(ptyId, first.emit);

    ptys.write(ptyId, "echo tide-pty-ok\n");
    await first.await(() => first.text.includes("tide-pty-ok"));

    // a second attach gets everything seen so far as ONE data chunk, then live output
    const second = new Sink();
    const detachSecond = ptys.attach(ptyId, second.emit);
    expect(second.chunks).toHaveLength(1);
    expect(second.chunks[0]?.kind).toBe("data");
    expect(second.text).toContain("tide-pty-ok");

    ptys.resize(ptyId, 120, 40);
    expect(ptys.list("th-1")).toEqual([{ ptyId, title: expect.any(String), alive: true }]);
    expect(ptys.list("th-other")).toEqual([]);

    ptys.write(ptyId, "exit\n");
    await first.await((c) => c.kind === "exit");
    await second.await((c) => c.kind === "exit");
    const exit = first.chunks.find((c) => c.kind === "exit");
    expect(exit).toMatchObject({ kind: "exit", code: 0 });
    expect(ptys.list("th-1")[0]?.alive).toBe(false);

    detach();
    detachSecond();
  }, 20_000);

  it("attaching to an already-exited terminal replays then reports the exit", async () => {
    const cwd = await tempDir();
    const ptys = new PtyManager();
    cleanups.push(() => ptys.closeAll());
    const ptyId = await ptys.create("th-2", cwd, 80, 24, "/bin/sh");
    const live = new Sink();
    ptys.attach(ptyId, live.emit);
    ptys.write(ptyId, "exit\n");
    await live.await((c) => c.kind === "exit");

    const late = new Sink();
    ptys.attach(ptyId, late.emit);
    expect(late.chunks.at(-1)?.kind).toBe("exit");
    expect(() => ptys.write(ptyId, "x")).toThrowError(expect.objectContaining({ code: "conflict" }));
  }, 20_000);

  it("kills a running terminal", async () => {
    const cwd = await tempDir();
    const ptys = new PtyManager();
    cleanups.push(() => ptys.closeAll());
    const ptyId = await ptys.create("th-3", cwd, 80, 24, "/bin/sh");
    const sink = new Sink();
    ptys.attach(ptyId, sink.emit);
    ptys.kill(ptyId);
    await sink.await((c) => c.kind === "exit");
    expect(ptys.list("th-3")[0]?.alive).toBe(false);
  }, 20_000);

  it("reports unknown terminals", () => {
    const ptys = new PtyManager();
    expect(() => ptys.kill("nope")).toThrowError(expect.objectContaining({ code: "not-found" }));
  });
});

// ---- fake backend: deterministic coverage of the bookkeeping ----

const ESC = "\x1b";
const BEL = "\x07";

describe("PtyManager bookkeeping (fake backend)", () => {
  it("uses the last OSC 0/2 title and falls back to the shell basename", async () => {
    const fake = fakeBackend();
    const ptys = new PtyManager({ backend: fake.backend });
    const id = await ptys.create("t", "/tmp", 80, 24, "/usr/local/bin/fish");
    expect(ptys.list("t")[0]?.title).toBe("fish");
    fake.handles[0]?.data(`${ESC}]0;first${BEL}${ESC}]2;second${BEL}rest`);
    expect(ptys.list("t")[0]?.title).toBe("second");
    expect(id).toBeTruthy();
  });

  it("keeps the scrollback under the ring size", async () => {
    const fake = fakeBackend();
    const ptys = new PtyManager({ backend: fake.backend, scrollbackBytes: 32 });
    const id = await ptys.create("t", "/tmp", 80, 24, "/bin/sh");
    for (let i = 0; i < 10; i++) fake.handles[0]?.data("0123456789");
    const sink = new Sink();
    ptys.attach(id, sink.emit);
    expect(sink.text.length).toBeLessThanOrEqual(40);
    expect(sink.text.endsWith("0123456789")).toBe(true);
  });

  it("reaps a dead terminal after the grace period", async () => {
    const fake = fakeBackend();
    const ptys = new PtyManager({ backend: fake.backend, reapAfterMs: 0 });
    await ptys.create("t", "/tmp", 80, 24, "/bin/sh");
    fake.handles[0]?.exit(0);
    // a 0ms timer queued after the reaper fires after it, in registration order
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(ptys.list("t")).toEqual([]);
  });

  it("forwards writes and resizes and kills everything on close", async () => {
    const fake = fakeBackend();
    const ptys = new PtyManager({ backend: fake.backend });
    const id = await ptys.create("t", "/tmp", 80, 24, "/bin/sh");
    ptys.write(id, "ls\n");
    ptys.resize(id, 10.7, 20.2);
    expect(fake.handles[0]?.written).toEqual(["ls\n"]);
    expect(fake.handles[0]?.resized).toEqual([[10, 20]]);
    ptys.closeAll();
    expect(fake.handles[0]?.killed).toBe(1);
    expect(ptys.list("t")).toEqual([]);
  });


  it("passes the terminal env and geometry through to the backend", async () => {
    const fake = fakeBackend();
    const ptys = new PtyManager({ backend: fake.backend });
    await ptys.create("th-env", "/tmp", 80, 24, "/bin/sh");
    const spec = fake.handles[0]?.spec;
    expect(spec?.cwd).toBe("/tmp");
    expect(spec?.env["TERM"]).toBe("xterm-256color");
    expect(spec?.env["COLORTERM"]).toBe("truecolor");
    expect(spec?.env["TIDE_THREAD_ID"]).toBe("th-env");
  });

  it("reports a signal exit once, even if kill and exit both fire", async () => {
    const fake = fakeBackend();
    const ptys = new PtyManager({ backend: fake.backend });
    const id = await ptys.create("t", "/tmp", 80, 24, "/bin/sh");
    const sink = new Sink();
    ptys.attach(id, sink.emit);
    ptys.kill(id);
    fake.handles[0]?.exit(0);
    expect(sink.chunks.filter((c) => c.kind === "exit")).toEqual([{ kind: "exit", code: 143, signal: "SIGTERM" }]);
  });
});

describe("pty backend selection", () => {
  it("does not pick the Bun backend under Node", () => {
    // vitest runs on Node, so `Bun` is undefined and node-pty is used; the Bun path is
    // covered by the manual check in apps/server/scripts/check-bun-pty.ts
    expect(isBunRuntime()).toBe(false);
  });

  it("maps a broken native module to `unavailable`", async () => {
    const ptys = new PtyManager({ backend: () => Promise.reject(new Error("no prebuild")) });
    await expect(ptys.create("t", "/tmp", 80, 24)).rejects.toMatchObject({
      code: "unavailable",
      message: "terminal support not built",
    });
  });
});

/** A manual clock for the command delay and the stop escalation. */
function manualTimers(): {
  schedule: (fn: () => void, ms: number) => () => void;
  sleep: (ms: number) => Promise<void>;
  advance: (ms: number) => Promise<void>;
  pending: () => number;
} {
  let now = 0;
  let timers: { at: number; fn: () => void }[] = [];
  const schedule = (fn: () => void, ms: number): (() => void) => {
    const t = { at: now + ms, fn };
    timers.push(t);
    return () => {
      timers = timers.filter((x) => x !== t);
    };
  };
  return {
    schedule,
    sleep: (ms) => new Promise<void>((resolve) => void schedule(resolve, ms)),
    async advance(ms) {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      timers = timers.filter((t) => t.at > now);
      for (const t of due) t.fn();
      // let awaiting code run its continuation
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
    pending: () => timers.length,
  };
}

describe("PtyManager owners, env, commands and stop (fake backend)", () => {
  it("keys terminals by ownerId and lists the label", async () => {
    const fake = fakeBackend();
    const ptys = new PtyManager({ backend: fake.backend });
    const a = await ptys.create({ ownerId: "run:p1", cwd: "/tmp", cols: 120, rows: 30, label: "api" });
    await ptys.create("th-1", "/tmp", 80, 24);
    expect(ptys.list("run:p1")).toEqual([{ ptyId: a, title: expect.any(String), alive: true, label: "api" }]);
    expect(ptys.list("th-1")).toHaveLength(1);
    expect(ptys.pids("run:p1")).toEqual([fake.handles[0]?.pid]);
    expect(ptys.pidOf(a)).toBe(fake.handles[0]?.pid);
    expect(ptys.killOwner("run:p1")).toBe(1);
    expect(ptys.alive(a)).toBe(false);
    expect(ptys.list("th-1")[0]?.alive).toBe(true);
  });

  it("merges env as process.env, then TERM/TIDE_*, then the caller's", async () => {
    const fake = fakeBackend();
    const ptys = new PtyManager({ backend: fake.backend });
    await ptys.create({ ownerId: "run:p1", cwd: "/tmp", cols: 80, rows: 24, env: { PORT: "8082", TERM: "dumb" } });
    const env = fake.handles[0]?.spec.env ?? {};
    expect(env["PORT"]).toBe("8082");
    expect(env["TERM"]).toBe("dumb");
    expect(env["COLORTERM"]).toBe("truecolor");
    expect(env["TIDE_RUN_PROJECT_ID"]).toBe("p1");
    expect(env["TIDE_THREAD_ID"]).toBeUndefined();
    expect(env["PATH"]).toBe(process.env["PATH"]);
  });

  it("types the command after the first output chunk, once, with a leading space", async () => {
    const fake = fakeBackend();
    const timers = manualTimers();
    const ptys = new PtyManager({ backend: fake.backend, schedule: timers.schedule });
    await ptys.create({ ownerId: "run:p1", cwd: "/tmp", cols: 80, rows: 24, command: "pnpm dev --port 8082" });
    expect(fake.handles[0]?.written).toEqual([]);
    fake.handles[0]?.data("% ");
    fake.handles[0]?.data("more");
    expect(fake.handles[0]?.written).toEqual([" pnpm dev --port 8082\n"]);
    expect(timers.pending()).toBe(0);
  });

  it("types the command after the delay when the shell stays silent", async () => {
    const fake = fakeBackend();
    const timers = manualTimers();
    const ptys = new PtyManager({ backend: fake.backend, schedule: timers.schedule });
    await ptys.create({ ownerId: "run:p1", cwd: "/tmp", cols: 80, rows: 24, command: "make dev" });
    await timers.advance(299);
    expect(fake.handles[0]?.written).toEqual([]);
    await timers.advance(1);
    expect(fake.handles[0]?.written).toEqual([" make dev\n"]);
    fake.handles[0]?.data("x");
    expect(fake.handles[0]?.written).toHaveLength(1);
  });

  it("rejects an oversized command", async () => {
    const ptys = new PtyManager({ backend: fakeBackend().backend });
    await expect(ptys.create({ ownerId: "t", cwd: "/tmp", cols: 80, rows: 24, command: "x".repeat(4097) })).rejects.toMatchObject({ code: "invalid-params" });
  });

  it("stops with SIGINT, then SIGTERM, then SIGKILL, waiting the grace between", async () => {
    const fake = fakeBackend();
    const timers = manualTimers();
    const ptys = new PtyManager({ backend: fake.backend, sleep: timers.sleep, stopPollMs: 3000, children: async () => [1] });
    const id = await ptys.create({ ownerId: "run:p1", cwd: "/tmp", cols: 80, rows: 24 });
    let done = false;
    const stopped = ptys.stop(id, { graceMs: 3000 }).then(() => {
      done = true;
    });
    await timers.advance(0);
    expect(fake.handles[0]?.signals).toEqual(["SIGINT"]);
    await timers.advance(3000);
    expect(fake.handles[0]?.signals).toEqual(["SIGINT", "SIGTERM"]);
    expect(done).toBe(false);
    await timers.advance(3000);
    await stopped;
    expect(fake.handles[0]?.signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(ptys.alive(id)).toBe(false);
  });

  it("hangs up a shell that outlived its children", async () => {
    const fake = fakeBackend();
    const timers = manualTimers();
    const ptys = new PtyManager({ backend: fake.backend, sleep: timers.sleep, stopPollMs: 250, children: async () => [] });
    const id = await ptys.create({ ownerId: "run:p1", cwd: "/tmp", cols: 80, rows: 24 });
    const stopped = ptys.stop(id);
    await timers.advance(0);
    await timers.advance(250);
    await stopped;
    expect(fake.handles[0]?.signals).toEqual(["SIGINT"]);
    expect(fake.handles[0]?.killed).toBe(1);
    expect(ptys.alive(id)).toBe(false);
  });

  it("stopOwner ends early when the tree exits on SIGINT", async () => {
    const fake = fakeBackend();
    const timers = manualTimers();
    const ptys = new PtyManager({ backend: fake.backend, sleep: timers.sleep });
    await ptys.create({ ownerId: "run:p1", cwd: "/tmp", cols: 80, rows: 24 });
    await ptys.create({ ownerId: "run:p1", cwd: "/tmp", cols: 80, rows: 24 });
    for (const h of fake.handles) h.diesOn.add("SIGINT");
    await ptys.stopOwner("run:p1");
    expect(fake.handles.map((h) => h.signals)).toEqual([["SIGINT"], ["SIGINT"]]);
    expect(ptys.pids("run:p1")).toEqual([]);
  });
});

describe("killProcessTree", () => {
  const PS = "  1 0\n 50 1\n 60 50\n 70 60\n 61 50\n 99 1\n";

  it("signals the group, then descendants deepest first, then the shell", async () => {
    const calls: [number, TreeSignal][] = [];
    await killProcessTree(50, "SIGTERM", { kill: (pid, sig) => void calls.push([pid, sig]), ps: async () => PS });
    expect(calls.map(([pid]) => pid)).toEqual([-50, 70, 61, 60, 50]);
    expect(calls.every(([, sig]) => sig === "SIGTERM")).toBe(true);
  });

  it("falls back to the ps walk when the group kill fails with ESRCH/EPERM", async () => {
    const calls: number[] = [];
    const kill = (pid: number): void => {
      calls.push(pid);
      if (pid < 0) throw Object.assign(new Error("no such process group"), { code: "ESRCH" });
      if (pid === 61) throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    };
    await killProcessTree(50, "SIGINT", { kill, ps: async () => PS });
    expect(calls).toEqual([-50, 70, 61, 60, 50]);
  });

  it("rethrows unexpected errors and survives a missing ps", async () => {
    await expect(killProcessTree(50, "SIGINT", { kill: () => { throw new Error("boom"); }, ps: async () => undefined })).rejects.toThrow("boom");
    const calls: number[] = [];
    await killProcessTree(50, "SIGINT", { kill: (pid) => void calls.push(pid), ps: async () => undefined });
    expect(calls).toEqual([-50, 50]);
    expect(descendants(50, new Map([[60, 50], [70, 60]]))).toEqual([70, 60]);
  });
});
