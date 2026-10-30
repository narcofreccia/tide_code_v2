import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { HOOK_TTL_MS } from "./hooks.ts";
import { createRelay, type Relay, type RelayOptions } from "./relay.ts";
import { closed, dataFrame, Inbox, logTap, opened, refused } from "./__tests__/helpers.ts";

const KEY = "test-relay-key-0123456789";
let relay: Relay;
let base: string;
let now = 1_000_000;
const sockets: WebSocket[] = [];

async function start(opts: Partial<RelayOptions> = {}): Promise<void> {
  relay = createRelay({ key: KEY, autoSweep: false, now: () => now, log: () => undefined, ...opts });
  base = `127.0.0.1:${await relay.listen(0, "127.0.0.1")}`;
}

function ws(path: string): WebSocket {
  const s = new WebSocket(`ws://${base}${path}`);
  sockets.push(s);
  return s;
}

async function env(id = "e1"): Promise<{ ws: WebSocket; inbox: Inbox }> {
  const s = ws(`/env/connect?env=${id}&key=${KEY}`);
  const inbox = new Inbox(s);
  await opened(s);
  return { ws: s, inbox };
}

async function client(path = "/c/e1/ws"): Promise<{ ws: WebSocket; inbox: Inbox }> {
  const s = ws(path);
  const inbox = new Inbox(s);
  await opened(s);
  return { ws: s, inbox };
}

type HttpFrame = { t: string; id: number; method: string; path: string; headers: Record<string, string>; body?: string };
const respond = (s: WebSocket, id: number, status: number, body: string, headers: Record<string, string> = {}) =>
  s.send(JSON.stringify({ t: "res", id, status, headers, body: Buffer.from(body).toString("base64") }));
const hook = (envId: string, hookId: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`http://${base}/hook/${envId}/${hookId}`, { method: "POST", body, headers });

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await relay.close();
  now = 1_000_000;
});

describe("relay: uplinks", () => {
  it("reports online environments on /health", async () => {
    await start();
    expect(await (await fetch(`http://${base}/health`)).json()).toEqual({ ok: true, environments: 0 });
    await env("e1");
    await env("e2");
    expect(await (await fetch(`http://${base}/health`)).json()).toEqual({ ok: true, environments: 2 });
  });

  it("refuses a bad or missing key with 401", async () => {
    await start();
    expect(await refused(ws(`/env/connect?env=e1&key=nope`))).toBe(401);
    expect(await refused(ws(`/env/connect?env=e1`))).toBe(401);
    expect(relay.environments()).toBe(0);
  });

  it("refuses an uplink without an environment id", async () => {
    await start();
    expect(await refused(ws(`/env/connect?key=${KEY}`))).toBe(400);
  });

  it("keeps one uplink per environment: the newer wins, the older is closed 4409", async () => {
    await start();
    const first = await env("e1");
    const gone = closed(first.ws);
    await env("e1");
    expect((await gone).code).toBe(4409);
    expect(relay.environments()).toBe(1);
  });

  it("answers the route preflight with the environment's presence", async () => {
    const tap = logTap();
    await start({ log: tap.log });
    const info = () => fetch(`http://${base}/c/e1/_relay/info`).then((r) => r.json());
    expect(await info()).toEqual({ online: false });
    const e = await env("e1");
    expect(await info()).toEqual({ online: true });
    const gone = tap.next("e1 disconnected");
    e.ws.close();
    await gone;
    expect(await info()).toEqual({ online: false });
  });

  it("404s unknown paths", async () => {
    await start();
    expect((await fetch(`http://${base}/nope`)).status).toBe(404);
    expect(await refused(ws("/elsewhere"))).toBe(404);
  });
});

describe("relay: websocket tunnel", () => {
  it("refuses a client when the environment is offline", async () => {
    await start();
    expect(await refused(ws("/c/e1/ws?wsTicket=t"))).toBe(503);
  });

  it("opens a channel with the client's query and pipes text and binary both ways", async () => {
    await start();
    const e = await env();
    const c = await client("/c/e1/ws?wsTicket=abc");
    const open = await e.inbox.json<{ t: string; c: number; path: string }>();
    expect(open).toEqual({ t: "open", c: 1, path: "/ws?wsTicket=abc" });

    c.ws.send('{"id":1}');
    const up = await e.inbox.next();
    expect(up.binary).toBe(true);
    expect(up.data).toEqual(dataFrame(1, '{"id":1}', false));
    c.ws.send(Buffer.from([1, 2, 3]));
    expect((await e.inbox.next()).data).toEqual(dataFrame(1, Buffer.from([1, 2, 3]), true));

    e.ws.send(dataFrame(1, '{"ok":true}', false));
    const text = await c.inbox.next();
    expect([text.binary, text.data.toString()]).toEqual([false, '{"ok":true}']);
    e.ws.send(dataFrame(1, Buffer.from([9]), true));
    const bin = await c.inbox.next();
    expect([bin.binary, [...bin.data]]).toEqual([true, [9]]);
  });

  it("gives each client its own channel", async () => {
    await start();
    const e = await env();
    const a = await client();
    const b = await client();
    expect((await e.inbox.json()).c).toBe(1);
    expect((await e.inbox.json()).c).toBe(2);
    e.ws.send(dataFrame(2, "to-b", false));
    expect((await b.inbox.next()).data.toString()).toBe("to-b");
    expect(a.inbox.size).toBe(0);
  });

  it("forwards a client close to the environment", async () => {
    await start();
    const e = await env();
    const c = await client();
    await e.inbox.json();
    c.ws.close(4000, "bye");
    expect(await e.inbox.json()).toEqual({ t: "close", c: 1, code: 4000, reason: "bye" });
  });

  it("closes the client when the environment closes the channel", async () => {
    await start();
    const e = await env();
    const c = await client();
    await e.inbox.json();
    const done = closed(c.ws);
    e.ws.send(JSON.stringify({ t: "close", c: 1, code: 4401, reason: "unauthorized" }));
    expect(await done).toEqual({ code: 4401, reason: "unauthorized" });
  });

  it("closes every channel when the uplink drops", async () => {
    await start();
    const e = await env();
    const c = await client();
    await e.inbox.json();
    const done = closed(c.ws);
    e.ws.terminate();
    expect((await done).code).toBe(1012);
  });

  it("caps channels per environment", async () => {
    await start({ maxChannels: 1 });
    await env();
    await client();
    expect(await refused(ws("/c/e1/ws"))).toBe(429);
  });

  it("closes a channel idle past idleMs on sweep", async () => {
    await start({ idleMs: 1_000 });
    const e = await env();
    const c = await client();
    await e.inbox.json();
    const done = closed(c.ws);
    now += 2_000;
    relay.sweep();
    expect((await done).code).toBe(1001);
    expect(await e.inbox.json()).toMatchObject({ t: "close", c: 1, code: 1001 });
  });
});

describe("relay: http tunnel", () => {
  it("round-trips method, path, query, headers, body and the response", async () => {
    await start();
    const e = await env();
    const pending = fetch(`http://${base}/c/e1/api/auth/pair?x=1`, { method: "POST", body: "code=42", headers: { "content-type": "text/plain", authorization: "Bearer t" } });
    const req = await e.inbox.json<HttpFrame>();
    expect(req).toMatchObject({ t: "http", method: "POST", path: "/api/auth/pair?x=1" });
    expect(req.headers).toMatchObject({ "content-type": "text/plain", authorization: "Bearer t", "x-tide-relay": "1" });
    expect(req.headers["host"]).toBeUndefined();
    expect(Buffer.from(req.body ?? "", "base64").toString()).toBe("code=42");
    respond(e.ws, req.id, 201, '{"paired":true}', { "content-type": "application/json", "x-env": "yes", "access-control-allow-origin": "http://local" });
    const res = await pending;
    expect(res.status).toBe(201);
    expect(res.headers.get("x-env")).toBe("yes");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({ paired: true });
  });

  it("answers CORS preflight on /c/* itself", async () => {
    await start();
    const res = await fetch(`http://${base}/c/e1/api/env`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("503s when the environment is offline and 504s when it drops mid-request", async () => {
    await start();
    expect((await fetch(`http://${base}/c/e1/api/env`)).status).toBe(503);
    const e = await env();
    const pending = fetch(`http://${base}/c/e1/api/env`);
    await e.inbox.json();
    e.ws.terminate();
    expect((await pending).status).toBe(504);
  });

  it("rejects request bodies over 8 MB", async () => {
    await start();
    await env();
    const res = await fetch(`http://${base}/c/e1/upload`, { method: "POST", body: Buffer.alloc(8 * 1024 * 1024 + 1) });
    expect(res.status).toBe(413);
  });
});

describe("relay: webhooks", () => {
  it("forwards a webhook to /hook/<id> when the environment is online", async () => {
    await start();
    const e = await env();
    const pending = hook("e1", "deploy", '{"ref":"main"}', { "x-hub-signature-256": "sha256=abc" });
    const req = await e.inbox.json<HttpFrame>();
    expect(req).toMatchObject({ method: "POST", path: "/hook/deploy" });
    expect(req.headers["x-hub-signature-256"]).toBe("sha256=abc");
    respond(e.ws, req.id, 200, '{"fired":1}', { "content-type": "application/json" });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fired: 1 });
  });

  it("holds webhooks while offline (202) and replays them in order on reconnect", async () => {
    await start();
    for (const n of [1, 2, 3]) expect((await hook("e1", `h${n}`, `body-${n}`)).status).toBe(202);
    expect(relay.hooks.pending("e1")).toBe(3);
    const e = await env();
    for (const n of [1, 2, 3]) {
      const req = await e.inbox.json<HttpFrame>();
      expect(req.path).toBe(`/hook/h${n}`);
      expect(Buffer.from(req.body ?? "", "base64").toString()).toBe(`body-${n}`);
      respond(e.ws, req.id, 200, "{}");
    }
    await fetch(`http://${base}/health`);
    expect(relay.hooks.pending("e1")).toBe(0);
  });

  it("queues a webhook behind held ones while a replay is running", async () => {
    await start();
    await hook("e1", "first", "1");
    const e = await env();
    const r1 = await e.inbox.json<HttpFrame>();
    expect((await hook("e1", "second", "2")).status).toBe(202);
    respond(e.ws, r1.id, 200, "{}");
    expect((await e.inbox.json<HttpFrame>()).path).toBe("/hook/second");
  });

  it("keeps a held hook when the environment drops during replay", async () => {
    const tap = logTap();
    await start({ log: tap.log });
    await hook("e1", "h", "x");
    const e = await env();
    await e.inbox.json();
    const gone = tap.next("e1 disconnected");
    e.ws.terminate();
    await gone;
    expect(relay.hooks.pending("e1")).toBe(1);
    const again = await env();
    expect((await again.inbox.json<HttpFrame>()).path).toBe("/hook/h");
  });

  it("drops held webhooks after 24 h", async () => {
    await start();
    await hook("e1", "stale", "x");
    now += HOOK_TTL_MS + 1;
    await hook("e1", "fresh", "y");
    const e = await env();
    expect((await e.inbox.json<HttpFrame>()).path).toBe("/hook/fresh");
  });

  it("dedupes by X-Tide-Delivery", async () => {
    await start();
    expect((await hook("e1", "h", "x", { "x-tide-delivery": "d1" })).status).toBe(202);
    const dup = await hook("e1", "h", "x", { "x-tide-delivery": "d1" });
    expect(dup.status).toBe(200);
    expect(await dup.json()).toMatchObject({ duplicate: true });
    expect(relay.hooks.pending("e1")).toBe(1);
    expect((await hook("e2", "h", "x", { "x-tide-delivery": "d1" })).status).toBe(202);
  });

  it("lets a sender retry a delivery the environment answered with 5xx", async () => {
    await start();
    const e = await env();
    const first = hook("e1", "h", "x", { "x-tide-delivery": "d9" });
    respond(e.ws, (await e.inbox.json<HttpFrame>()).id, 500, '{"error":"boom"}');
    expect((await first).status).toBe(500);
    const retry = hook("e1", "h", "x", { "x-tide-delivery": "d9" });
    respond(e.ws, (await e.inbox.json<HttpFrame>()).id, 200, "{}");
    expect((await retry).status).toBe(200);
  });

  it("rejects webhook bodies over 256 KB", async () => {
    await start();
    expect((await hook("e1", "h", "x".repeat(256 * 1024 + 1))).status).toBe(413);
    expect(relay.hooks.pending("e1")).toBe(0);
  });

  it("keeps held webhooks across a relay restart (sqlite file)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dbPath = join(mkdtempSync(join(tmpdir(), "relay-")), "relay.db");
    await start({ dbPath });
    await hook("e1", "persisted", "x");
    await relay.close();
    await start({ dbPath });
    const e = await env();
    expect((await e.inbox.json<HttpFrame>()).path).toBe("/hook/persisted");
  });
});
