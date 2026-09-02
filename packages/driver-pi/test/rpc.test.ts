import { describe, expect, it } from "vitest";
import { PiRpc, splitJsonl } from "../src/index.ts";
import type { TimerLike } from "../src/types.ts";
import type { PiLine } from "../src/types.ts";
import { fakePi } from "./fake-pi.ts";

describe("NDJSON framing", () => {
  it("splits on LF only and strips a trailing CR", () => {
    const lines: string[] = [];
    const rest = splitJsonl("a\r\nb\nc d\npartial", (line) => lines.push(line));
    expect(lines).toEqual(["a", "b", "c d"]);
    expect(rest).toBe("partial");
  });

  it("reassembles a JSON object split across chunk boundaries", async () => {
    const pi = fakePi();
    const seen: PiLine[] = [];
    new PiRpc(pi, { onLine: (line) => seen.push(line), log: () => undefined });
    pi.writeRaw('{"type":"agent_st');
    pi.writeRaw('art"}\n{"type":"agent_settled"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen.map((line) => line.type)).toEqual(["agent_start", "agent_settled"]);
  });

  it("survives an unparseable line instead of throwing", async () => {
    const pi = fakePi();
    const logs: string[] = [];
    const seen: PiLine[] = [];
    new PiRpc(pi, { onLine: (line) => seen.push(line), log: (message) => logs.push(message) });
    pi.writeRaw("not json\n{\"type\":\"agent_end\"}\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(logs.some((line) => line.includes("unparseable"))).toBe(true);
    expect(seen.map((line) => line.type)).toEqual(["agent_end"]);
  });
});

describe("request/response correlation", () => {
  it("resolves each request with the response carrying its id", async () => {
    const pi = fakePi((command, self) => {
      // answer out of order to prove correlation is by id, not by arrival
      if (command["type"] === "get_state") setTimeout(() => self.emitLine({ type: "response", id: command["id"], command: "get_state", success: true, data: { sessionId: "s1" } }), 10);
      if (command["type"] === "get_session_stats") self.emitLine({ type: "response", id: command["id"], command: "get_session_stats", success: true, data: { cost: 1 } });
    });
    const rpc = new PiRpc(pi, { onLine: () => undefined, log: () => undefined });
    const state = rpc.request({ type: "get_state" });
    const stats = rpc.request({ type: "get_session_stats" });
    expect((await stats).data).toEqual({ cost: 1 });
    expect((await state).data).toEqual({ sessionId: "s1" });
    expect(pi.sent.map((command) => command["id"])).toEqual(["tide-1", "tide-2"]);
  });

  it("passes uncorrelated responses and events through to onLine", async () => {
    const pi = fakePi();
    const seen: PiLine[] = [];
    new PiRpc(pi, { onLine: (line) => seen.push(line), log: () => undefined });
    pi.emitLine({ type: "response", command: "parse", success: false, error: "boom" });
    pi.emitLine({ type: "extension_ui_request", id: "u1", method: "notify", message: "hi" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen.map((line) => line.type)).toEqual(["response", "extension_ui_request"]);
  });

  it("rejects everything in flight when pi exits", async () => {
    const pi = fakePi();
    const rpc = new PiRpc(pi, { onLine: () => undefined, log: () => undefined });
    const pending = rpc.request({ type: "get_state" });
    pi.exit(1);
    await expect(pending).rejects.toThrow(/exited with code 1/);
    await expect(rpc.request({ type: "get_state" })).rejects.toThrow(/exited/);
  });

  it("`data()` returns undefined for a failed command rather than throwing", async () => {
    const pi = fakePi((command, self) => self.emitLine({ type: "response", id: command["id"], command: "set_model", success: false, error: "Model not found" }));
    const rpc = new PiRpc(pi, { onLine: () => undefined, log: () => undefined });
    expect(await rpc.data({ type: "set_model" })).toBeUndefined();
  });
});

describe("child lifecycle", () => {
  /** Deterministic stand-in for `setTimeout`: the test decides when the grace period ends. */
  function fakeTimers(): TimerLike & { run(): void; pending: number } {
    const scheduled = new Map<number, () => void>();
    let next = 1;
    return {
      setTimeout(fn) {
        const handle = next++;
        scheduled.set(handle, fn);
        return handle;
      },
      clearTimeout(handle) {
        scheduled.delete(handle as number);
      },
      run() {
        for (const fn of [...scheduled.values()]) fn();
        scheduled.clear();
      },
      get pending() {
        return scheduled.size;
      },
    };
  }

  it("escalates SIGTERM to SIGKILL when pi refuses to exit", () => {
    const pi = fakePi();
    pi.ignoreSigterm = true;
    const timers = fakeTimers();
    const rpc = new PiRpc(pi, { onLine: () => undefined, log: () => undefined, timers, killGraceMs: 5_000 });
    rpc.close();
    expect(pi.signals).toEqual(["SIGTERM"]);
    timers.run();
    expect(pi.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("does not SIGKILL a pi that exited on SIGTERM", () => {
    const pi = fakePi();
    const timers = fakeTimers();
    const rpc = new PiRpc(pi, { onLine: () => undefined, log: () => undefined, timers });
    rpc.close();
    expect(pi.signals).toEqual(["SIGTERM"]);
    expect(timers.pending).toBe(0);
  });

  it("tells the owner the child died, but stays quiet when Tide closed it deliberately", () => {
    const deaths: string[] = [];
    const pi = fakePi();
    new PiRpc(pi, { onLine: () => undefined, log: () => undefined, onExit: (error) => deaths.push(error.message) });
    pi.exit(9);
    expect(deaths).toEqual(["pi exited with code 9"]);

    const other = fakePi();
    const closed: string[] = [];
    const rpc = new PiRpc(other, { onLine: () => undefined, log: () => undefined, onExit: (error) => closed.push(error.message) });
    rpc.close();
    expect(closed).toEqual([]);
  });
});
