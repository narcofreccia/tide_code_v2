import { describe, expect, it } from "vitest";
import { JsonRpcConnection, JsonRpcError } from "./jsonrpc.ts";

function harness(): { connection: JsonRpcConnection; written: string[]; notifications: [string, unknown][]; requests: [string, unknown, string | number][]; logs: string[] } {
  const written: string[] = [];
  const notifications: [string, unknown][] = [];
  const requests: [string, unknown, string | number][] = [];
  const logs: string[] = [];
  const connection = new JsonRpcConnection((line) => written.push(line), {
    onNotification: (method, params) => notifications.push([method, params]),
    onRequest: (method, params, id) => requests.push([method, params, id]),
    onLog: (message) => logs.push(message),
  });
  return { connection, written, notifications, requests, logs };
}

describe("json-rpc framing and correlation", () => {
  it("frames every outgoing message as one newline-terminated line", () => {
    const { connection, written } = harness();
    void connection.request("thread/start", { cwd: "/tmp" });
    connection.notify("initialized", {});
    expect(written).toHaveLength(2);
    expect(written.every((line) => line.endsWith("\n") && line.slice(0, -1).includes("\n") === false)).toBe(true);
    expect(JSON.parse(written[0]!)).toEqual({ jsonrpc: "2.0", id: 1, method: "thread/start", params: { cwd: "/tmp" } });
    expect(JSON.parse(written[1]!)).toEqual({ jsonrpc: "2.0", method: "initialized", params: {} });
  });

  it("resolves a response to its own request, out of order and across chunk splits", async () => {
    const { connection } = harness();
    const first = connection.request<{ ok: number }>("a");
    const second = connection.request<{ ok: number }>("b");
    // one line arriving in three pieces, then two responses in one chunk
    connection.ingest('{"jsonrpc":"2.0","id":2,');
    connection.ingest('"result":{"ok":');
    connection.ingest('2}}\n{"jsonrpc":"2.0","id":1,"result":{"ok":1}}\n');
    expect(await second).toEqual({ ok: 2 });
    expect(await first).toEqual({ ok: 1 });
  });

  it("rejects with the server's code and message", async () => {
    const { connection } = harness();
    const call = connection.request("thread/start");
    connection.ingest('{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"unknown variant `unlessTrusted`"}}\n');
    await expect(call).rejects.toBeInstanceOf(JsonRpcError);
    await expect(call).rejects.toMatchObject({ code: -32600, message: "unknown variant `unlessTrusted`" });
  });

  it("routes notifications and server requests apart, and logs unusable lines", () => {
    const { connection, notifications, requests, logs } = harness();
    connection.ingest('{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"t"}}\n');
    connection.ingest('{"jsonrpc":"2.0","id":"req-7","method":"item/fileChange/requestApproval","params":{"itemId":"i"}}\n');
    connection.ingest("not json\n\n");
    connection.ingest('{"jsonrpc":"2.0","id":99,"result":{}}\n');
    expect(notifications).toEqual([["turn/started", { threadId: "t" }]]);
    expect(requests).toEqual([["item/fileChange/requestApproval", { itemId: "i" }, "req-7"]]);
    expect(logs).toEqual(["unparsable line: not json", "response for unknown id 99"]);
  });

  it("answers a server request on the same id, as result or as error", () => {
    const { connection, written } = harness();
    connection.respond("req-7", { decision: "accept" });
    connection.respondError(8, -32601, "unhandled");
    expect(JSON.parse(written[0]!)).toEqual({ jsonrpc: "2.0", id: "req-7", result: { decision: "accept" } });
    expect(JSON.parse(written[1]!)).toEqual({ jsonrpc: "2.0", id: 8, error: { code: -32601, message: "unhandled" } });
  });

  it("fails every in-flight call when the child goes away", async () => {
    const { connection, written } = harness();
    const call = connection.request("turn/start");
    connection.close("codex app-server exited");
    await expect(call).rejects.toThrow("codex app-server exited");
    await expect(connection.request("turn/start")).rejects.toThrow("closed");
    connection.notify("ignored");
    expect(written).toHaveLength(1);
  });
});
