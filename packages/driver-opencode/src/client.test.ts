import { afterEach, describe, expect, it, vi } from "vitest";
import { authHeader, HttpOpencodeApi, parseSse } from "./client.ts";

function body(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("parseSse", () => {
  it("reads `data:` frames split across chunks, skipping heartbeats and junk", async () => {
    const events = [];
    const stream = body(['data: {"id":"e1","type":"server.connected","data":{}}\n\n: heartbeat\n\ndata: {"type":"session.te', 'xt.delta","data":{"delta":"hi"}}\r\n\r\n', "data: not json\n\n", 'data: {"type":"tail"}']);
    for await (const event of parseSse(stream)) events.push(event.type);
    expect(events).toEqual(["server.connected", "session.text.delta", "tail"]);
  });

  it("builds the service's Basic auth header (user `opencode`)", () => {
    expect(authHeader({ url: "http://x", password: "pw" })).toEqual({ authorization: `Basic ${Buffer.from("opencode:pw").toString("base64")}` });
    expect(authHeader({ url: "http://x" })).toEqual({});
  });
});

describe("HttpOpencodeApi steer / fork / rollback routes (2.0.27 @opencode/protocol groups/session.js, message.js)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(answers: Record<string, unknown> = {}): { method: string; url: string; body?: unknown }[] {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { method: string; body?: string }) => {
      calls.push({ method: init.method, url, ...(init.body !== undefined ? { body: JSON.parse(init.body) as unknown } : {}) });
      const path = url.replace("http://oc", "").split("?")[0] ?? "";
      const answer = answers[path];
      return { ok: true, status: answer === undefined ? 204 : 200, text: async () => (answer === undefined ? "" : JSON.stringify(answer)) };
    });
    return calls;
  }

  it("sends each call to its route with the documented body", async () => {
    const calls = stubFetch({
      "/api/session/s1/prompt": { data: { id: "msg_1", type: "user" } },
      "/api/session/s1/message": { data: [{ id: "msg_1", type: "user" }], cursor: { next: "abc" } },
      "/api/session/s1/fork": { data: { id: "s2", location: { directory: "/repo" } } },
    });
    const api = new HttpOpencodeApi({ url: "http://oc" });
    expect(await api.prompt({ sessionId: "s1", text: "hi", delivery: "steer" })).toEqual({ id: "msg_1", type: "user" });
    expect((await api.messages({ sessionId: "s1", limit: 200 })).cursor?.next).toBe("abc");
    await api.messages({ sessionId: "s1", limit: 200, cursor: "abc" });
    expect((await api.fork({ sessionId: "s1" })).id).toBe("s2");
    await api.revertStage({ sessionId: "s1", messageId: "msg_1", files: false });
    await api.revertCommit({ sessionId: "s1" });
    await api.moveSession({ sessionId: "s2", directory: "/wt" });
    await api.waitIdle({ sessionId: "s2" });
    await api.removeSession({ sessionId: "s2" });
    expect(calls).toEqual([
      { method: "POST", url: "http://oc/api/session/s1/prompt", body: { text: "hi", delivery: "steer" } },
      { method: "GET", url: "http://oc/api/session/s1/message?limit=200&order=desc" },
      // the server rejects a cursor combined with order
      { method: "GET", url: "http://oc/api/session/s1/message?limit=200&cursor=abc" },
      { method: "POST", url: "http://oc/api/session/s1/fork", body: {} },
      { method: "POST", url: "http://oc/api/session/s1/revert/stage", body: { messageID: "msg_1", files: false } },
      { method: "POST", url: "http://oc/api/session/s1/revert/commit" },
      { method: "POST", url: "http://oc/api/session/s2/move", body: { directory: "/wt" } },
      { method: "POST", url: "http://oc/api/experimental/session/s2/wait" },
      { method: "DELETE", url: "http://oc/api/session/s2" },
    ]);
  });
});
