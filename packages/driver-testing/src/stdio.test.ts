import { describe, expect, it } from "vitest";
import { AppServer } from "@tide/driver-codex";
import { PiRpc } from "@tide/driver-pi";
import { Recorder } from "./recorder.ts";
import { recordSpawn, replaySpawn } from "./stdio.ts";
import { Replay } from "./transport.ts";
import { parseTranscript } from "./frames.ts";

const lines = (...frames: unknown[]): string => frames.map((frame) => JSON.stringify(frame)).join("\n");
const start = { t: "start", provider: "codex", version: "0.0.0", scenario: "unit", synthetic: true };

describe("replaySpawn with the real Codex AppServer", () => {
  const handshake = [
    { t: "expect_out", match: { method: "initialize", params: { clientInfo: { name: "tide" } } } },
    { t: "in", frame: { jsonrpc: "2.0", id: "$id", result: { userAgent: "fake" } } },
    { t: "expect_out", match: { method: "initialized" } },
  ];

  it("completes the handshake, answers a request and delivers server notifications", async () => {
    const replay = Replay.fromString(
      lines(
        start,
        ...handshake,
        { t: "expect_out", match: { method: "thread/start", params: { cwd: "/repo" } } },
        { t: "in", frame: { jsonrpc: "2.0", id: "$id", result: { thread: { id: "th-1" } } } },
        { t: "in", frame: { jsonrpc: "2.0", method: "thread/started", params: { n: 1 } } },
      ),
    );
    const spawn = replaySpawn(replay);
    const notifications: string[] = [];
    const server = await AppServer.start({ binaryPath: "codex", cwd: "/repo", env: {}, spawn, log: () => undefined, onNotification: (method) => notifications.push(method) });
    const result = await server.request<{ thread: { id: string } }>("thread/start", { cwd: "/repo" });
    expect(result.thread.id).toBe("th-1");
    expect(notifications).toEqual(["thread/started"]);
    expect(spawn.children[0]?.call.args).toEqual(["app-server"]);
    server.close();
    expect(spawn.children[0]?.signals).toEqual(["SIGTERM"]);
    replay.assertDrained();
  });

  it("makes a wrong request fail the call site and the final assertion", async () => {
    const replay = Replay.fromString(lines(start, ...handshake, { t: "expect_out", match: { method: "thread/start" } }));
    const server = await AppServer.start({ binaryPath: "codex", cwd: "/repo", env: {}, spawn: replaySpawn(replay), log: () => undefined });
    expect(() => void server.request("thread/resume", {})).toThrow(/does not match expect_out/);
    expect(() => replay.assertDrained()).toThrow(/thread\/resume/);
    // not closed on purpose: close() would reject the orphaned pending call of the throwing request
  });

  it("delivers a scripted exit as the child's exit event", async () => {
    const replay = Replay.fromString(lines(start, ...handshake, { t: "expect_out", match: { method: "turn/start" } }, { t: "exit", code: 137 }));
    const reasons: string[] = [];
    const server = await AppServer.start({ binaryPath: "codex", cwd: "/repo", env: {}, spawn: replaySpawn(replay), log: () => undefined, onExit: (reason) => reasons.push(reason) });
    const pending = server.request("turn/start", {});
    await expect(pending).rejects.toThrow(/exited \(code 137\)/);
    expect(reasons).toEqual(["codex app-server exited (code 137)"]);
  });
});

describe("replaySpawn with the real PiRpc", () => {
  it("correlates responses by id and passes other lines through", async () => {
    const replay = Replay.fromString(
      lines(
        { ...start, provider: "pi" },
        { t: "expect_out", match: { type: "get_state", id: "tide-1" } },
        { t: "in", frame: { type: "response", id: "$id", command: "get_state", success: true, data: { sessionId: "s" } } },
        { t: "in", frame: { type: "agent_start" } },
      ),
    );
    const child = replaySpawn(replay)("pi", ["--mode", "rpc"], { cwd: "/repo", env: {} });
    const seen: unknown[] = [];
    const rpc = new PiRpc(child as never, { onLine: (line) => seen.push(line), log: () => undefined });
    const response = await rpc.request({ type: "get_state" });
    expect(response).toMatchObject({ success: true, data: { sessionId: "s" } });
    expect(seen).toEqual([{ type: "agent_start" }]);
    rpc.close();
    replay.assertDrained();
  });
});

describe("ReplayChild stdout", () => {
  it("never nests data events: a reply written from inside a handler is queued behind the current line", () => {
    const replay = Replay.fromString(
      lines(
        { ...start, provider: "pi" },
        { t: "expect_out", match: { n: 1 } },
        { t: "in", frame: { line: "a" } },
        { t: "expect_out", match: { n: 2 } },
        { t: "in", frame: { line: "b" } },
      ),
    );
    const child = replaySpawn(replay)("pi", [], { cwd: "/", env: {} });
    const order: string[] = [];
    let depth = 0;
    child.stdout.on("data", (chunk: string) => {
      depth++;
      order.push(`start ${chunk.trim()} depth ${depth}`);
      if (chunk.includes('"a"')) child.stdin.write('{"n":2}\n'); // answered from inside the handler
      order.push(`end ${chunk.trim()}`);
      depth--;
    });
    child.stdin.write('{"n":1}\n');
    expect(order).toEqual(['start {"line":"a"} depth 1', 'end {"line":"a"}', 'start {"line":"b"} depth 1', 'end {"line":"b"}']);
    replay.assertDrained();
  });
});

describe("recordSpawn", () => {
  it("records stdin lines as expect_out and stdout lines as in, in order, and replays cleanly", async () => {
    // a "real" child: the replay child of a hand-written transcript stands in for the process
    const source = Replay.fromString(
      lines(start, { t: "expect_out", match: { method: "ping" } }, { t: "in", frame: { id: 1, result: "pong", token: "s3cret" } }, { t: "in", frame: { method: "tick" } }, { t: "exit", code: 0 }),
    );
    const recorder = new Recorder({ provider: "codex", version: "0.0.0", scenario: "rt" });
    const spawn = recordSpawn(replaySpawn(source), recorder);
    const child = spawn("codex", [], { cwd: "/", env: {} });
    const got: string[] = [];
    child.stdout?.on("data", (chunk: string) => got.push(chunk));
    child.stdin?.write(`${JSON.stringify({ id: 1, method: "ping", apiKey: "k-123" })}\n`);

    const recorded = parseTranscript(recorder.toString());
    expect(recorded.start).toMatchObject({ provider: "codex", scenario: "rt" });
    expect(recorded.processes[0]?.frames).toEqual([
      { t: "expect_out", match: { id: 1, method: "ping", apiKey: "$any" } },
      { t: "in", frame: { id: 1, result: "pong", token: "[redacted]" } },
      { t: "in", frame: { method: "tick" } },
      { t: "exit", code: 0 },
    ]);
    expect(got).toHaveLength(2); // the driver still received everything
    // and the recording replays the same conversation
    const replay = new Replay(recorded);
    const replayed = replaySpawn(replay)("codex", [], { cwd: "/", env: {} });
    const again: string[] = [];
    replayed.stdout.on("data", (chunk: string) => again.push(chunk));
    replayed.stdin.write(`${JSON.stringify({ id: 1, method: "ping", apiKey: "other" })}\n`);
    expect(again.map((line) => JSON.parse(line))).toEqual([{ id: 1, result: "pong", token: "[redacted]" }, { method: "tick" }]);
    replay.assertDrained();
  });
});
