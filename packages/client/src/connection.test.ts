import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RpcCallError, TideConnection } from "./connection.ts";
import { FakeServer, waitFor } from "./testServer.ts";
import type { ModelChunk } from "@tide/contracts";

let server: FakeServer;

const connect = (over: Partial<ConstructorParameters<typeof TideConnection>[0]> = {}): TideConnection =>
  new TideConnection({
    url: server.url,
    auth: { kind: "token", token: "dev-token" },
    backoff: { minMs: 5, maxMs: 20, jitter: 0 },
    ...over,
  });

beforeEach(async () => {
  server = await FakeServer.start();
});
afterEach(async () => {
  await server.stop();
});

describe("TideConnection", () => {
  it("puts the dev token on the query string and resolves unary calls", async () => {
    server.handler = (req, sock) => {
      if (req.method === "server.info") {
        server.send(sock, { id: req.id, result: { environmentId: "env-1", version: "0.0.0", startedAt: 1 } });
      }
    };
    const conn = connect();
    await conn.connect();
    const info = await conn.call("server.info", {});
    expect(info.environmentId).toBe("env-1");
    expect(server.urls[0]).toContain("token=dev-token");
    conn.close();
  });

  it("fetches a ws ticket when configured", async () => {
    server.handler = (req, sock) => server.send(sock, { id: req.id, result: { ok: true } });
    const conn = connect({ auth: { kind: "ticket", getTicket: async () => "tk-42" } });
    await conn.connect();
    expect(server.urls[0]).toContain("wsTicket=tk-42");
    conn.close();
  });

  it("rejects with an RpcCallError on error frames", async () => {
    server.handler = (req, sock) =>
      server.send(sock, { id: req.id, error: { code: "bad_command", message: "nope" } });
    const conn = connect();
    await conn.connect();
    await expect(conn.call("model.get", {})).rejects.toMatchObject({
      name: "RpcCallError",
      code: "bad_command",
      message: "nope",
    });
    conn.close();
  });

  it("delivers stream chunks until end and settles done", async () => {
    server.handler = (req, sock) => {
      if (req.method !== "model.subscribe") return;
      server.send(sock, { id: req.id, chunk: { kind: "snapshot", model: { seq: 3 } } });
      server.send(sock, { id: req.id, chunk: { kind: "event", record: { seq: 4 } } });
      server.send(sock, { id: req.id, end: true });
    };
    const conn = connect();
    await conn.connect();
    const chunks: ModelChunk[] = [];
    const sub = conn.stream("model.subscribe", {}, (c) => chunks.push(c));
    await sub.done;
    expect(chunks.map((c) => c.kind)).toEqual(["snapshot", "event"]);
    conn.close();
  });

  it("cancel() sends unsubscribe for the stream id and settles done", async () => {
    server.handler = (req, sock) => {
      if (req.method === "unsubscribe") server.send(sock, { id: req.id, result: { ok: true } });
    };
    const conn = connect();
    await conn.connect();
    const sub = conn.stream("model.subscribe", {}, () => undefined);
    sub.cancel();
    await sub.done;
    await waitFor(() => server.requests.some((r) => r.method === "unsubscribe"));
    const unsub = server.requests.find((r) => r.method === "unsubscribe");
    expect(unsub?.params).toEqual({ id: sub.id });
    conn.close();
  });

  it("rejects in-flight work with `disconnected` and reconnects", async () => {
    server.handler = (req, sock) => {
      if (req.method === "server.info") server.dropClients();
      else server.send(sock, { id: req.id, result: {} });
    };
    const conn = connect();
    const statuses: string[] = [];
    conn.on("status", (s) => statuses.push(s));
    await conn.connect();

    const pending = conn.call("server.info", {});
    await expect(pending).rejects.toMatchObject({ code: "disconnected" });

    await waitFor(() => conn.status === "open");
    expect(statuses).toContain("reconnecting");
    expect(server.urls.length).toBeGreaterThanOrEqual(2);
    conn.close();
    expect(conn.status).toBe("closed");
  });
});
