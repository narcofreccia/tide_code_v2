import { describe, expect, it } from "vitest";
import { HttpOpencodeApi } from "@tide/driver-opencode";
import { Recorder } from "./recorder.ts";
import { recordFetch, replayFetch, requestFrame } from "./http.ts";
import { parseTranscript } from "./frames.ts";
import { Replay } from "./transport.ts";

const lines = (...frames: unknown[]): string => frames.map((frame) => JSON.stringify(frame)).join("\n");
const start = { t: "start", provider: "opencode", version: "2.0.27", scenario: "unit", synthetic: true };

describe("requestFrame", () => {
  it("keeps method, path with query and a parsed JSON body, and drops the origin and headers", () => {
    expect(requestFrame("http://h:1/api/model?a=b", { method: "post", body: '{"x":1}', headers: { authorization: "Basic abc" } })).toEqual({ method: "POST", path: "/api/model?a=b", body: { x: 1 } });
    expect(requestFrame("http://h/api/info", undefined)).toEqual({ method: "GET", path: "/api/info" });
  });
});

describe("replayFetch", () => {
  it("answers JSON requests, empty bodies and error statuses", async () => {
    const replay = Replay.fromString(
      lines(
        start,
        { t: "expect_out", match: { method: "POST", path: "/api/session", body: { location: { directory: "/repo" } } } },
        { t: "in", frame: { status: 200, body: { data: { id: "ses_1" } } } },
        { t: "expect_out", match: { method: "POST", path: "/api/session/ses_1/interrupt" } },
        { t: "in", frame: { status: 204 } },
        { t: "expect_out", match: { method: "GET", path: "/api/session/nope" } },
        { t: "in", frame: { status: 404, body: "not here" } },
      ),
    );
    const { fetch } = replayFetch(replay);
    const created = await fetch("http://x/api/session", { method: "POST", body: JSON.stringify({ location: { directory: "/repo" }, title: "t" }) });
    expect(await created.json()).toEqual({ data: { id: "ses_1" } });
    const empty = await fetch("http://x/api/session/ses_1/interrupt", { method: "POST" });
    expect([empty.status, await empty.text()]).toEqual([204, ""]);
    const missing = await fetch("http://x/api/session/nope");
    expect([missing.ok, await missing.text()]).toEqual([false, "not here"]);
    replay.assertDrained();
  });

  it("rejects a request that does not match, with the diff", async () => {
    const replay = Replay.fromString(lines(start, { t: "expect_out", match: { method: "GET", path: "/api/info" } }, { t: "in", frame: { status: 200 } }));
    const { fetch } = replayFetch(replay);
    await expect(fetch("http://x/api/model")).rejects.toThrow(/\$.path: expected "\/api\/info", got "\/api\/model"/);
    expect(() => replay.assertDrained()).toThrow(/does not match/);
  });

  it("rejects instead of hanging when the transcript has no response", async () => {
    const replay = Replay.fromString(lines(start, { t: "expect_out", match: { method: "GET", path: "/a" } }));
    await expect(replayFetch(replay).fetch("http://x/a")).rejects.toThrow(/no response for GET \/a/);
  });

  it("streams SSE frames to an open event stream and closes it on abort or sseEnd", async () => {
    const replay = Replay.fromString(
      lines(
        start,
        { t: "expect_out", match: { method: "GET", path: "/api/event" } },
        { t: "in", frame: { status: 200, stream: true } },
        { t: "expect_out", match: { method: "POST", path: "/api/session/s/prompt", body: { text: "hi" } } },
        { t: "in", frame: { status: 200, body: { data: { id: "msg_u1" } } } },
        { t: "in", frame: { sse: { type: "session.text.delta", data: { delta: "yo" } } } },
        { t: "in", frame: { sseRaw: ": heartbeat\n\n" } },
        { t: "in", frame: { sse: { type: "session.execution.succeeded", data: {} } } },
        { t: "in", frame: { sseEnd: true } },
      ),
    );
    const api = new HttpOpencodeApi({ url: "http://replay" }, replayFetch(replay).fetch);
    const events = await api.subscribe({ signal: new AbortController().signal });
    const received: string[] = [];
    const reading = (async () => {
      for await (const event of events) received.push(event.type);
    })();
    await expect(api.prompt({ sessionId: "s", text: "hi" })).resolves.toEqual({ id: "msg_u1" });
    await reading;
    expect(received).toEqual(["session.text.delta", "session.execution.succeeded"]);
    replay.assertDrained();
  });

  it("an aborted subscription ends the stream", async () => {
    const replay = Replay.fromString(lines(start, { t: "expect_out", match: { path: "/api/event" } }, { t: "in", frame: { status: 200, stream: true } }));
    const abort = new AbortController();
    const api = new HttpOpencodeApi({ url: "http://replay" }, replayFetch(replay).fetch);
    const events = await api.subscribe({ signal: abort.signal });
    const reading = (async () => {
      for await (const _ of events) void _;
    })();
    abort.abort();
    await reading;
  });
});

describe("recordFetch", () => {
  it("records requests and responses (JSON and SSE) and the result replays", async () => {
    const source = Replay.fromString(
      lines(
        start,
        { t: "expect_out", match: { method: "GET", path: "/api/event" } },
        { t: "in", frame: { status: 200, stream: true } },
        { t: "expect_out", match: { method: "POST", path: "/api/session/s/prompt" } },
        { t: "in", frame: { status: 200, body: { data: { id: "msg_u1" } } } },
        { t: "in", frame: { sse: { type: "session.execution.succeeded", data: {} } } },
        { t: "in", frame: { sseEnd: true } },
      ),
    );
    const recorder = new Recorder({ provider: "opencode", version: "2.0.27", scenario: "rt" });
    const api = new HttpOpencodeApi({ url: "http://replay", password: "pw" }, recordFetch(replayFetch(source).fetch, recorder));
    const events = await api.subscribe({ signal: new AbortController().signal });
    const reading = (async () => {
      const seen: string[] = [];
      for await (const event of events) seen.push(event.type);
      return seen;
    })();
    await api.prompt({ sessionId: "s", text: "hi" });
    expect(await reading).toEqual(["session.execution.succeeded"]);
    await new Promise((resolve) => setImmediate(resolve)); // the tap reads its tee branch

    const recorded = parseTranscript(recorder.toString());
    const frames = recorded.processes[0]!.frames;
    expect(frames.slice(0, 3)).toEqual([
      { t: "expect_out", match: { method: "GET", path: "/api/event" } },
      { t: "in", frame: { status: 200, stream: true } },
      { t: "expect_out", match: { method: "POST", path: "/api/session/s/prompt", body: { text: "hi" } } },
    ]);
    // the prompt response and the SSE events race on a real wire, so only their presence is fixed
    expect(frames.slice(3)).toEqual(
      expect.arrayContaining([
        { t: "in", frame: { status: 200, body: { data: { id: "msg_u1" } } } },
        { t: "in", frame: { sse: { type: "session.execution.succeeded", data: {} } } },
        { t: "in", frame: { sseEnd: true } },
      ]),
    );
  });
});
