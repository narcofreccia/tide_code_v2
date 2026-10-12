import { describe, expect, it } from "vitest";
import { authHeader, parseSse } from "./client.ts";

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
