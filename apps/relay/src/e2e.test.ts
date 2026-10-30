import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createRelayClient, type RelayClient } from "../../server/src/relay/client.ts";
import { createRelay, type Relay } from "./relay.ts";
import { closed, Inbox, logTap, opened } from "./__tests__/helpers.ts";

/** relay + the real environment-side client + a stand-in tide-server on loopback */
const KEY = "e2e-relay-key-0123456789";
let relay: Relay;
let relayUrl: string;
let tap: ReturnType<typeof logTap>;
let envServer: Server;
let envPort: number;
let hits: { path: string; relayed: string | undefined; body: string }[];
let client: RelayClient;
let retries: { fn: () => void; ms: number }[];
let onRetry: ((r: { fn: () => void; ms: number }) => void) | undefined;
let onHit: (() => void) | undefined;
const nextRetry = () => new Promise<{ fn: () => void; ms: number }>((resolve) => (onRetry = resolve));
const nextHit = () => new Promise<void>((resolve) => (onHit = resolve));
const sockets: WebSocket[] = [];

beforeEach(async () => {
  hits = [];
  retries = [];
  tap = logTap();
  relay = createRelay({ key: KEY, autoSweep: false, log: tap.log });
  relayUrl = `http://127.0.0.1:${await relay.listen(0, "127.0.0.1")}`;
  envServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      hits.push({ path: req.url ?? "", relayed: req.headers["x-tide-relay"] as string | undefined, body });
      onHit?.();
      res.writeHead(req.url?.startsWith("/hook/") ? 202 : 200, { "content-type": "application/json", "x-env": "e1" });
      res.end(JSON.stringify({ path: req.url }));
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  envServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (url.pathname !== "/ws" || url.searchParams.get("token") !== "ok") return ws.close(4401, "unauthorized");
      ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
    });
  });
  envPort = await new Promise<number>((resolve) => envServer.listen(0, "127.0.0.1", () => resolve((envServer.address() as AddressInfo).port)));
  client = createRelayClient({ environmentId: "e1", port: envPort, schedule: (fn, ms) => {
      retries.push({ fn, ms });
      onRetry?.({ fn, ms });
      return () => undefined;
    } });
});

afterEach(async () => {
  client.stop();
  for (const s of sockets.splice(0)) s.terminate();
  await relay.close();
  envServer.closeAllConnections();
  await new Promise<void>((resolve) => envServer.close(() => resolve()));
});

async function connect(): Promise<void> {
  const up = tap.next("e1 connected");
  client.restart({ url: relayUrl, key: KEY });
  await up;
}

function tunnel(query: string): WebSocket {
  const s = new WebSocket(`${relayUrl.replace("http", "ws")}/c/e1/ws${query}`);
  sockets.push(s);
  return s;
}

describe("relay end-to-end with the environment client", () => {
  it("echoes text and binary frames through the tunnel with the client's query", async () => {
    await connect();
    const s = tunnel("?token=ok");
    const inbox = new Inbox(s);
    await opened(s);
    s.send('{"method":"server.info"}');
    const text = await inbox.next();
    expect([text.binary, text.data.toString()]).toEqual([false, '{"method":"server.info"}']);
    s.send(Buffer.from([0, 255]));
    const bin = await inbox.next();
    expect([bin.binary, [...bin.data]]).toEqual([true, [0, 255]]);
  });

  it("lets the environment refuse the client itself", async () => {
    await connect();
    expect((await closed(tunnel("?token=wrong"))).code).toBe(4401);
  });

  it("forwards http to the loopback server and marks it as relayed", async () => {
    await connect();
    const res = await fetch(`${relayUrl}/c/e1/api/env?x=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-env")).toBe("e1");
    expect(await res.json()).toEqual({ path: "/api/env?x=1" });
    expect(hits[0]).toMatchObject({ path: "/api/env?x=1", relayed: "1" });
  });

  it("delivers a live webhook to /hook/<id>", async () => {
    await connect();
    const res = await fetch(`${relayUrl}/hook/e1/nightly`, { method: "POST", body: '{"a":1}' });
    expect(res.status).toBe(202);
    expect(hits).toEqual([{ path: "/hook/nightly", relayed: "1", body: '{"a":1}' }]);
  });

  it("replays webhooks held while the environment was offline", async () => {
    await fetch(`${relayUrl}/hook/e1/one`, { method: "POST", body: "1" });
    await fetch(`${relayUrl}/hook/e1/two`, { method: "POST", body: "2" });
    let second: Promise<void> | undefined;
    const first = nextHit();
    await connect();
    await first.then(() => (second = nextHit()));
    await second;
    expect(hits.filter((h) => h.path.startsWith("/hook/")).map((h) => h.path)).toEqual(["/hook/one", "/hook/two"]);
  });

  it("reports state with the client url", async () => {
    expect(client.state()).toBeUndefined();
    await connect();
    await fetch(`${relayUrl}/c/e1/ping`); // the uplink's open handler has run once it answers
    expect(client.state()).toEqual({ url: relayUrl, connected: true, clientUrl: `${relayUrl}/c/e1` });
  });

  it("reconnects with backoff after a drop and routes channels again", async () => {
    await connect();
    const retry = nextRetry();
    const gone = tap.next("e1 disconnected");
    const intruder = new WebSocket(`${relayUrl.replace("http", "ws")}/env/connect?env=e1&key=${KEY}`);
    sockets.push(intruder);
    await opened(intruder); // supersedes the client's uplink (4409)
    const firstRetry = await retry;
    expect(firstRetry.ms).toBe(1_000);
    intruder.terminate();
    await gone;
    const back = tap.next("e1 connected");
    firstRetry.fn();
    await back;
    const s = tunnel("?token=ok");
    const inbox = new Inbox(s);
    await opened(s);
    s.send("again");
    expect((await inbox.next()).data.toString()).toBe("again");
  });

  it("disconnects on restart(undefined)", async () => {
    await connect();
    const gone = tap.next("e1 disconnected");
    client.restart(undefined);
    await gone;
    expect(client.state()).toBeUndefined();
    expect(relay.environments()).toBe(0);
  });
});
