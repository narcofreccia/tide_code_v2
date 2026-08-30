import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { RpcFrame } from "@tide/contracts";
import type { ServerConfig } from "../config.ts";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { startServer, type ServerHandle } from "./server.ts";

const TOKEN = "test-token";

const config: ServerConfig = {
  tideHome: "/tmp/tide-test",
  dataDir: ":memory:",
  dbPath: ":memory:",
  environmentId: "env-test",
  token: TOKEN,
  host: "127.0.0.1",
  port: 0,
  dev: true,
  printToken: false,
  corsOrigins: ["http://localhost:5173"],
  version: "0.0.0-test",
};

/** Minimal promise-based RPC client so tests never sleep. */
class TestClient {
  #ws: WebSocket;
  #nextId = 0;
  #pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  #chunks = new Map<string, { queue: unknown[]; waiters: ((v: unknown) => void)[]; ended: boolean }>();
  #unmatched: { queue: RpcFrame[]; waiters: ((f: RpcFrame) => void)[] } = { queue: [], waiters: [] };

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on("message", (data) => this.#onFrame(JSON.parse(data.toString()) as RpcFrame));
  }

  static open(url: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once("open", () => resolve(new TestClient(ws)));
      ws.once("error", reject);
      ws.once("close", (code) => reject(new Error(`closed ${code}`)));
    });
  }

  #onFrame(frame: RpcFrame): void {
    if ("chunk" in frame || "end" in frame) {
      const stream = this.#chunks.get(frame.id);
      if (!stream) return;
      const value = "end" in frame ? { end: true } : frame.chunk;
      if ("end" in frame) stream.ended = true;
      const waiter = stream.waiters.shift();
      if (waiter) waiter(value);
      else stream.queue.push(value);
      return;
    }
    const pending = this.#pending.get(frame.id);
    if (!pending) {
      const waiter = this.#unmatched.waiters.shift();
      if (waiter) waiter(frame);
      else this.#unmatched.queue.push(frame);
      return;
    }
    this.#pending.delete(frame.id);
    if ("error" in frame) pending.reject(frame.error);
    else pending.resolve(frame.result);
  }

  call(method: string, params: unknown): Promise<unknown> {
    const id = `r${++this.#nextId}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Starts a stream and returns its id plus a next() pull. */
  stream(method: string, params: unknown): { id: string; next: () => Promise<unknown> } {
    const id = `s${++this.#nextId}`;
    const state = { queue: [] as unknown[], waiters: [] as ((v: unknown) => void)[], ended: false };
    this.#chunks.set(id, state);
    this.#ws.send(JSON.stringify({ id, method, params }));
    const next = (): Promise<unknown> => {
      const queued = state.queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve) => state.waiters.push(resolve));
    };
    return { id, next };
  }

  sendRaw(text: string): void {
    this.#ws.send(text);
  }

  /** Next frame that does not belong to an outstanding call or stream. */
  nextUnmatched(): Promise<RpcFrame> {
    const queued = this.#unmatched.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.#unmatched.waiters.push(resolve));
  }

  hasBufferedChunks(id: string): boolean {
    return (this.#chunks.get(id)?.queue.length ?? 0) > 0;
  }

  close(): void {
    this.#ws.close();
  }
}

let server: ServerHandle;
let store: EventStore;
let engine: Engine;
let base: string;

beforeAll(async () => {
  store = new EventStore(await openDatabase(":memory:"));
  engine = new Engine({ store });
  server = await startServer({ engine, store, config });
  base = `127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  store.close();
});

describe("http", () => {
  it("serves /health", async () => {
    const res = await fetch(`http://${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, environmentId: "env-test", version: "0.0.0-test" });
  });

  it("requires a bearer token for ws tickets", async () => {
    const res = await fetch(`http://${base}/api/auth/ws-ticket`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("issues ws tickets to an authorised caller", async () => {
    const res = await fetch(`http://${base}/api/auth/ws-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: string; expiresAt: number };
    expect(body.ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });
});

/** The server completes the handshake then closes, so the client sees the code. */
function closeCodeFor(url: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.once("close", (code) => resolve(code));
  });
}

describe("websocket auth", () => {
  it("rejects an invalid ticket with 4401", async () => {
    expect(await closeCodeFor(`ws://${base}/ws?wsTicket=bogus`)).toBe(4401);
  });

  it("rejects a missing ticket with 4401", async () => {
    expect(await closeCodeFor(`ws://${base}/ws`)).toBe(4401);
  });

  it("rejects a bad dev token with 4401", async () => {
    expect(await closeCodeFor(`ws://${base}/ws?token=wrong`)).toBe(4401);
  });

  it("accepts a freshly issued ticket, once", async () => {
    const res = await fetch(`http://${base}/api/auth/ws-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const { ticket } = (await res.json()) as { ticket: string };
    const client = await TestClient.open(`ws://${base}/ws?wsTicket=${ticket}`);
    client.close();

    // single use: the same ticket no longer works
    expect(await closeCodeFor(`ws://${base}/ws?wsTicket=${ticket}`)).toBe(4401);
  });
});

describe("rpc", () => {
  let client: TestClient;

  beforeAll(async () => {
    client = await TestClient.open(`ws://${base}/ws?token=${TOKEN}`);
  });
  afterAll(() => client.close());

  it("answers server.info", async () => {
    expect(await client.call("server.info", {})).toMatchObject({ environmentId: "env-test", version: "0.0.0-test" });
  });

  it("rejects unknown methods and invalid params", async () => {
    await expect(client.call("nope", {})).rejects.toMatchObject({ code: "method-not-found" });
    await expect(client.call("orchestration.dispatch", { command: { type: "bogus" } })).rejects.toMatchObject({ code: "invalid-params" });
  });

  it("surfaces decider rejections", async () => {
    await expect(
      client.call("orchestration.dispatch", { command: { type: "project.archive", projectId: "ghost" } }),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("streams a snapshot then live events, and stops on unsubscribe", async () => {
    const sub = client.stream("model.subscribe", {});
    const snapshot = (await sub.next()) as { kind: string; model: { seq: number } };
    expect(snapshot.kind).toBe("snapshot");

    await client.call("orchestration.dispatch", { command: { type: "project.create", title: "Streamed", rootPath: "/streamed" } });
    const evt = (await sub.next()) as { kind: string; record: { event: { type: string } } };
    expect(evt.kind).toBe("event");
    expect(evt.record.event.type).toBe("project.created");

    expect(await client.call("unsubscribe", { id: sub.id })).toEqual({ ok: true });
    expect(await sub.next()).toEqual({ end: true });

    await client.call("orchestration.dispatch", { command: { type: "project.create", title: "After", rootPath: "/after" } });
    // round-trip a second call so any stray chunk would have arrived by now
    await client.call("model.get", {});
    expect(client.hasBufferedChunks(sub.id)).toBe(false);
    expect(await client.call("unsubscribe", { id: sub.id })).toEqual({ ok: false });
  });

  it("replays from fromSeq instead of sending a snapshot", async () => {
    const sub = client.stream("model.subscribe", { fromSeq: 0 });
    const first = (await sub.next()) as { kind: string; record: { seq: number } };
    expect(first.kind).toBe("event");
    expect(first.record.seq).toBe(1);
    await client.call("unsubscribe", { id: sub.id });
  });

  it("errors on malformed JSON", async () => {
    const pending = client.nextUnmatched();
    client.sendRaw("{not json");
    expect(await pending).toEqual({ id: "", error: { code: "bad-request", message: "malformed JSON frame" } });
  });

  it("errors on a frame that is not an RpcRequest", async () => {
    const pending = client.nextUnmatched();
    client.sendRaw(JSON.stringify({ nope: true }));
    expect(await pending).toMatchObject({ id: "", error: { code: "bad-request" } });
  });

  it("returns the model from model.get", async () => {
    const model = (await client.call("model.get", {})) as { seq: number };
    expect(model.seq).toBeGreaterThan(0);
  });
});
