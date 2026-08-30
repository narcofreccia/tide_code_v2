import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PtyChunk } from "@tide/contracts";
import { PtyManager } from "./pty.ts";

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

// ---- fake module: deterministic coverage of the bookkeeping ----

interface FakeHandle {
  data(chunk: string): void;
  exit(code: number): void;
  written: string[];
  resized: [number, number][];
  killed: number;
}

function fakeModule(): { load: () => Promise<never>; handles: FakeHandle[] } {
  const handles: FakeHandle[] = [];
  const module = {
    spawn() {
      let onData: (d: string) => void = () => undefined;
      let onExit: (e: { exitCode: number; signal?: number }) => void = () => undefined;
      const handle: FakeHandle = {
        data: (chunk) => onData(chunk),
        exit: (code) => onExit({ exitCode: code }),
        written: [],
        resized: [],
        killed: 0,
      };
      handles.push(handle);
      return {
        pid: 1,
        onData: (cb: (d: string) => void) => {
          onData = cb;
        },
        onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
          onExit = cb;
        },
        write: (data: string) => handle.written.push(data),
        resize: (cols: number, rows: number) => handle.resized.push([cols, rows]),
        kill: () => {
          handle.killed++;
          onExit({ exitCode: 143 });
        },
      };
    },
  };
  return { load: (() => Promise.resolve(module)) as unknown as () => Promise<never>, handles };
}

const ESC = "\x1b";
const BEL = "\x07";

describe("PtyManager bookkeeping", () => {
  it("uses the last OSC 0/2 title and falls back to the shell basename", async () => {
    const fake = fakeModule();
    const ptys = new PtyManager({ load: fake.load });
    const id = await ptys.create("t", "/tmp", 80, 24, "/usr/local/bin/fish");
    expect(ptys.list("t")[0]?.title).toBe("fish");
    fake.handles[0]?.data(`${ESC}]0;first${BEL}${ESC}]2;second${BEL}rest`);
    expect(ptys.list("t")[0]?.title).toBe("second");
    expect(id).toBeTruthy();
  });

  it("keeps the scrollback under the ring size", async () => {
    const fake = fakeModule();
    const ptys = new PtyManager({ load: fake.load, scrollbackBytes: 32 });
    const id = await ptys.create("t", "/tmp", 80, 24, "/bin/sh");
    for (let i = 0; i < 10; i++) fake.handles[0]?.data("0123456789");
    const sink = new Sink();
    ptys.attach(id, sink.emit);
    expect(sink.text.length).toBeLessThanOrEqual(40);
    expect(sink.text.endsWith("0123456789")).toBe(true);
  });

  it("reaps a dead terminal after the grace period", async () => {
    const fake = fakeModule();
    const ptys = new PtyManager({ load: fake.load, reapAfterMs: 0 });
    await ptys.create("t", "/tmp", 80, 24, "/bin/sh");
    fake.handles[0]?.exit(0);
    // a 0ms timer queued after the reaper fires after it, in registration order
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(ptys.list("t")).toEqual([]);
  });

  it("forwards writes and resizes and kills everything on close", async () => {
    const fake = fakeModule();
    const ptys = new PtyManager({ load: fake.load });
    const id = await ptys.create("t", "/tmp", 80, 24, "/bin/sh");
    ptys.write(id, "ls\n");
    ptys.resize(id, 10.7, 20.2);
    expect(fake.handles[0]?.written).toEqual(["ls\n"]);
    expect(fake.handles[0]?.resized).toEqual([[10, 20]]);
    ptys.closeAll();
    expect(fake.handles[0]?.killed).toBe(1);
    expect(ptys.list("t")).toEqual([]);
  });

  it("maps a broken native module to `unavailable`", async () => {
    const ptys = new PtyManager({ load: () => Promise.reject(new Error("no prebuild")) as Promise<never> });
    await expect(ptys.create("t", "/tmp", 80, 24)).rejects.toMatchObject({
      code: "unavailable",
      message: "terminal support not built",
    });
  });
});
