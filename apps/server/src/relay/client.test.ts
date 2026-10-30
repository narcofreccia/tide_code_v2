import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { SettingsStore } from "../settings.ts";
import { backoffMs, createRelayClient, relayUrls, startRelayClient, type RelayClient } from "./client.ts";

/** A fake relay (bare WebSocketServer) and a fake loopback tide-server, both on port 0. */
let relay: WebSocketServer;
let relayPort: number;
let uplinks: { ws: WebSocket; url: string; next: () => Promise<{ data: Buffer; binary: boolean }> }[];
let onUplink: (() => void) | undefined;
let loop: Server;
let loopPort: number;
let loopSockets: { ws: WebSocket; url: string; relayed: string | undefined; inbox: { data: Buffer; binary: boolean }[] }[];
let onLoopSocket: (() => void) | undefined;
let onLoopMessage: (() => void) | undefined;
let client: RelayClient | undefined;
let retries: { fn: () => void; ms: number }[];
let onRetry: (() => void) | undefined;

const until = (set: (fn: () => void) => void, ready: () => boolean): Promise<void> =>
  ready() ? Promise.resolve() : new Promise((resolve) => set(() => ready() && resolve()));
const uplinkCount = (n: number) => until((fn) => (onUplink = fn), () => uplinks.length >= n);
const loopCount = (n: number) => until((fn) => (onLoopSocket = fn), () => loopSockets.length >= n);
const retryCount = (n: number) => until((fn) => (onRetry = fn), () => retries.length >= n);
const listen = (s: Server) => new Promise<number>((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
const frame = (c: number, payload: string, binary = false) => {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(c, 0);
  head.writeUInt8(binary ? 1 : 0, 4);
  return Buffer.concat([head, Buffer.from(payload)]);
};

beforeEach(async () => {
  uplinks = [];
  loopSockets = [];
  retries = [];
  relay = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => relay.once("listening", resolve));
  relayPort = (relay.address() as AddressInfo).port;
  relay.on("connection", (ws, req) => {
    const queue: { data: Buffer; binary: boolean }[] = [];
    let waiter: ((m: { data: Buffer; binary: boolean }) => void) | undefined;
    ws.on("message", (data, binary) => {
      const m = { data: data as Buffer, binary };
      if (waiter) {
        const w = waiter;
        waiter = undefined;
        w(m);
      } else queue.push(m);
    });
    const next = () => (queue.length > 0 ? Promise.resolve(queue.shift()!) : new Promise<{ data: Buffer; binary: boolean }>((resolve) => (waiter = resolve)));
    uplinks.push({ ws, url: req.url ?? "", next });
    onUplink?.();
  });

  loop = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      res.writeHead(req.url === "/missing" ? 404 : 200, { "content-type": "text/plain", "x-relayed": String(req.headers["x-tide-relay"]), "x-method": req.method ?? "" });
      res.end(`echo:${req.url}:${body}`);
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  loop.on("upgrade", (req, socket, head) =>
    wss.handleUpgrade(req, socket, head, (ws) => {
      const entry = { ws, url: req.url ?? "", relayed: req.headers["x-tide-relay"] as string | undefined, inbox: [] as { data: Buffer; binary: boolean }[] };
      ws.on("message", (data, binary) => {
        entry.inbox.push({ data: data as Buffer, binary });
        onLoopMessage?.();
      });
      loopSockets.push(entry);
      onLoopSocket?.();
    }),
  );
  loopPort = await listen(loop);
});

afterEach(async () => {
  client?.stop();
  client = undefined;
  for (const c of relay.clients) c.terminate();
  await new Promise((resolve) => relay.close(resolve));
  loop.closeAllConnections();
  await new Promise((resolve) => loop.close(resolve));
});

function make(): RelayClient {
  client = createRelayClient({
    environmentId: "env-1",
    port: loopPort,
    schedule: (fn, ms) => {
      retries.push({ fn, ms });
      onRetry?.();
      return () => undefined;
    },
  });
  return client;
}

async function connected(): Promise<(typeof uplinks)[number]> {
  make().restart({ url: `http://127.0.0.1:${relayPort}`, key: "k" });
  await uplinkCount(1);
  return uplinks[0]!;
}

describe("relayUrls", () => {
  it("derives the uplink and the client url from an https relay", () => {
    expect(relayUrls("https://relay.example/", "env 1", "s3cret")).toEqual({
      uplink: "wss://relay.example/env/connect?env=env+1&key=s3cret",
      clientUrl: "https://relay.example/c/env%201",
    });
  });

  it("accepts a ws(s) url and a plain-http relay", () => {
    expect(relayUrls("wss://relay.example", "e").clientUrl).toBe("https://relay.example/c/e");
    expect(relayUrls("http://10.0.0.2:8787", "e").uplink).toBe("ws://10.0.0.2:8787/env/connect?env=e");
  });

  it("backs off from 1 s doubling up to 60 s", () => {
    expect([0, 1, 2, 5, 6, 20].map(backoffMs)).toEqual([1_000, 2_000, 4_000, 32_000, 60_000, 60_000]);
  });
});

describe("createRelayClient", () => {
  it("dials the relay with env id and key, and reports state", async () => {
    const c = make();
    expect(c.state()).toBeUndefined();
    c.restart({ url: `http://127.0.0.1:${relayPort}`, key: "k" });
    await uplinkCount(1);
    expect(uplinks[0]!.url).toBe("/env/connect?env=env-1&key=k");
    // an http round trip proves the client has processed its open event
    uplinks[0]!.ws.send(JSON.stringify({ t: "http", id: 1, method: "GET", path: "/x", headers: {} }));
    await uplinks[0]!.next();
    expect(c.state()).toEqual({ url: `http://127.0.0.1:${relayPort}`, connected: true, clientUrl: `http://127.0.0.1:${relayPort}/c/env-1` });
  });

  it("routes a channel to a loopback /ws with the client's query and pipes frames both ways", async () => {
    const up = await connected();
    up.ws.send(JSON.stringify({ t: "open", c: 7, path: "/ws?wsTicket=abc" }));
    up.ws.send(frame(7, "early")); // before the loopback socket opened: queued, not lost
    await loopCount(1);
    const sock = loopSockets[0]!;
    expect(sock.url).toBe("/ws?wsTicket=abc");
    expect(sock.relayed).toBe("1");
    await until((fn) => (onLoopMessage = fn), () => sock.inbox.length >= 1);
    expect(sock.inbox[0]).toEqual({ data: Buffer.from("early"), binary: false });
    up.ws.send(frame(7, "bin", true));
    await until((fn) => (onLoopMessage = fn), () => sock.inbox.length >= 2);
    expect(sock.inbox[1]!.binary).toBe(true);

    sock.ws.send("from-server");
    const back = await up.next();
    expect(back.binary).toBe(true);
    expect(back.data).toEqual(frame(7, "from-server"));
  });

  it("sends a close frame when the loopback socket closes", async () => {
    const up = await connected();
    up.ws.send(JSON.stringify({ t: "open", c: 2, path: "/ws?token=t" }));
    await loopCount(1);
    loopSockets[0]!.ws.close(4401, "unauthorized");
    expect(JSON.parse((await up.next()).data.toString())).toEqual({ t: "close", c: 2, code: 4401, reason: "unauthorized" });
  });

  it("closes the loopback socket on a close frame from the relay", async () => {
    const up = await connected();
    up.ws.send(JSON.stringify({ t: "open", c: 3, path: "/ws" }));
    await loopCount(1);
    const sock = loopSockets[0]!;
    const done = new Promise<number>((resolve) => sock.ws.once("close", (code) => resolve(code)));
    up.ws.send(JSON.stringify({ t: "close", c: 3, code: 1006 }));
    expect(await done).toBe(1011);
  });

  it("refuses channels for paths other than /ws", async () => {
    const up = await connected();
    up.ws.send(JSON.stringify({ t: "open", c: 4, path: "/admin" }));
    expect(JSON.parse((await up.next()).data.toString())).toMatchObject({ t: "close", c: 4, code: 4404 });
  });

  it("performs http frames against loopback and returns status, headers and body", async () => {
    const up = await connected();
    up.ws.send(JSON.stringify({ t: "http", id: 9, method: "POST", path: "/hook/nightly?x=1", headers: { "content-type": "application/json" }, body: Buffer.from('{"a":1}').toString("base64") }));
    const res = JSON.parse((await up.next()).data.toString()) as { t: string; id: number; status: number; headers: Record<string, string>; body: string };
    expect(res).toMatchObject({ t: "res", id: 9, status: 200 });
    expect(res.headers).toMatchObject({ "x-relayed": "1", "x-method": "POST" });
    expect(res.headers["content-length"]).toBeUndefined();
    expect(Buffer.from(res.body, "base64").toString()).toBe('echo:/hook/nightly?x=1:{"a":1}');
  });

  it("passes non-2xx statuses through and rejects paths that would leave loopback", async () => {
    const up = await connected();
    up.ws.send(JSON.stringify({ t: "http", id: 1, method: "GET", path: "/missing", headers: {} }));
    expect(JSON.parse((await up.next()).data.toString())).toMatchObject({ id: 1, status: 404 });
    up.ws.send(JSON.stringify({ t: "http", id: 2, method: "GET", path: "//evil.example/x", headers: {} }));
    expect(JSON.parse((await up.next()).data.toString())).toMatchObject({ id: 2, status: 400 });
  });

  it("reconnects after a drop with backoff and routes channels on the new uplink", async () => {
    const up = await connected();
    up.ws.send(JSON.stringify({ t: "open", c: 1, path: "/ws" }));
    await loopCount(1);
    const loopClosed = new Promise((resolve) => loopSockets[0]!.ws.once("close", resolve));
    up.ws.terminate();
    await retryCount(1);
    await loopClosed; // channels die with their uplink
    expect(retries[0]!.ms).toBe(1_000);
    retries[0]!.fn();
    await uplinkCount(2);
    const again = uplinks[1]!;
    again.ws.send(JSON.stringify({ t: "open", c: 1, path: "/ws?token=t" }));
    await loopCount(2);
    expect(loopSockets[1]!.url).toBe("/ws?token=t");
    // a successful connect resets the backoff
    again.ws.terminate();
    await retryCount(2);
    expect(retries[1]!.ms).toBe(1_000);
  });

  it("grows the backoff while the relay keeps refusing", async () => {
    const refusing = createServer((_req, res) => {
      res.writeHead(401);
      res.end();
    });
    const port = await listen(refusing);
    make().restart({ url: `http://127.0.0.1:${port}`, key: "bad" });
    await retryCount(1);
    retries[0]!.fn();
    await retryCount(2);
    expect(retries.map((r) => r.ms)).toEqual([1_000, 2_000]);
    expect(client!.state()?.connected).toBe(false);
    refusing.closeAllConnections();
    await new Promise((resolve) => refusing.close(resolve));
  });

  it("stop() and restart(undefined) drop the uplink and forget the relay", async () => {
    const up = await connected();
    const gone = new Promise((resolve) => up.ws.once("close", resolve));
    client!.restart(undefined);
    await gone;
    expect(client!.state()).toBeUndefined();
    expect(retries).toEqual([]);
  });
});

describe("startRelayClient", () => {
  it("starts from settings and follows relay changes made through settings.set", async () => {
    const settings = new SettingsStore();
    settings.set({ relay: { url: `http://127.0.0.1:${relayPort}`, key: "first" } });
    client = startRelayClient(settings, { environmentId: "env-1", port: loopPort });
    await uplinkCount(1);
    expect(uplinks[0]!.url).toContain("key=first");

    settings.set({ followUpMode: "queue" }); // unrelated: no reconnect
    settings.set({ relay: { url: `http://127.0.0.1:${relayPort}`, key: "second" } });
    await uplinkCount(2);
    expect(uplinks.length).toBe(2);
    expect(uplinks[1]!.url).toContain("key=second");

    settings.set({ relay: null });
    expect(client.state()).toBeUndefined();
  });
});
