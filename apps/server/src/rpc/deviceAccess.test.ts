import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PairResponse, PairedClient, ServerInfo } from "@tide/contracts";
import WebSocket from "ws";
import type { ServerConfig } from "../config.ts";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { deviceGuard } from "./env.ts";
import { ClientTokenStore } from "./clientTokens.ts";
import { RELAY_PAIR_ATTEMPTS_PER_MINUTE } from "./pairing.ts";
import { startServer, type ServerHandle } from "./server.ts";
import { WsTestClient } from "./testing/wsClient.ts";

/** R18: owner vs paired-device powers, and the Host / Origin rules on the live listener. */

const TOKEN = "device-access-token";
const config: ServerConfig = {
  tideHome: "/tmp/tide-device-access",
  dataDir: ":memory:",
  dbPath: ":memory:",
  environmentId: "env-access",
  token: TOKEN,
  host: "127.0.0.1",
  port: 0,
  dev: false,
  printToken: false,
  corsOrigins: [],
  version: "1.0.0",
  providers: {},
};

let home: string;
let handle: ServerHandle;
let store: EventStore;
let base: string;
let relayUrl: string | undefined;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "tide-access-"));
  store = new EventStore(await openDatabase(":memory:"));
  relayUrl = undefined;
  handle = await startServer({
    engine: new Engine({ store }),
    store,
    config,
    clientTokens: new ClientTokenStore({ path: join(home, "clients.json") }),
    allowedHosts: ["tide.example.com"],
    relayState: () => (relayUrl === undefined ? undefined : { url: relayUrl, connected: true, clientUrl: `${relayUrl.replace(/^wss/, "https")}/c/env-access` }),
  });
  base = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.close();
  store.close();
  rmSync(home, { recursive: true, force: true });
});

const pairBody = (code: string, name = "phone"): string => JSON.stringify({ code, name });
const pairWith = (code: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}/api/auth/pair`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: pairBody(code) });

async function socket(token: string): Promise<WsTestClient> {
  const res = await fetch(`${base}/api/auth/ws-ticket`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  const { ticket } = (await res.json()) as { ticket: string };
  return WsTestClient.open(`ws://127.0.0.1:${handle.port}/ws?wsTicket=${ticket}`);
}

async function pairDevice(name: string): Promise<PairResponse> {
  const res = await fetch(`${base}/api/auth/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: pairBody(handle.pairing.issue().code, name) });
  expect(res.status).toBe(200);
  return (await res.json()) as PairResponse;
}

/** A raw HTTP request with a chosen Host header (fetch does not let a caller set it). */
function rawGet(path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: handle.port, path, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("owner-only methods", () => {
  it("refuses pairing codes, others' revocation and exposure settings to a device; the owner keeps them", async () => {
    const phone = await pairDevice("phone");
    const laptop = await pairDevice("laptop");
    const device = await socket(phone.token);
    const owner = await socket(TOKEN);
    try {
      // env.pairingCode
      expect((await device.expectError("env.pairingCode", {})).code).toBe("forbidden");
      expect((await owner.call<{ code: string }>("env.pairingCode", {})).code).toMatch(/^\d{6}$/);
      // env.clients.list: a device sees its own row only
      const mine = (await device.call<{ clients: PairedClient[] }>("env.clients.list", {})).clients;
      expect(mine.map((c) => c.id)).toEqual([phone.clientId]);
      expect((await owner.call<{ clients: PairedClient[] }>("env.clients.list", {})).clients).toHaveLength(2);
      // env.clients.revoke: not another device
      const refused = await device.expectError("env.clients.revoke", { id: laptop.clientId });
      expect(refused.code).toBe("forbidden");
      expect(refused.message).toMatch(/only itself/);
      expect(handle.clientTokens.has(laptop.clientId as string)).toBe(true);
      // settings.set: exposure keys refused, the rest writable
      expect((await device.expectError("settings.set", { patch: { relay: { url: "wss://r.example" } } })).code).toBe("forbidden");
      expect((await device.expectError("settings.set", { patch: { relay: null } })).code).toBe("forbidden");
      expect((await device.expectError("settings.set", { patch: { environment: { lanBind: true } } })).code).toBe("forbidden");
      const renamed = await device.call<{ environment: { name: string } }>("settings.set", { patch: { environment: { name: "renamed by phone" } } });
      expect(renamed.environment.name).toBe("renamed by phone");
      expect((await owner.call<{ environment: { lanBind?: boolean } }>("settings.set", { patch: { environment: { lanBind: true } } })).environment.lanBind).toBe(true);
      // server.info: the pairing URL carries the master token, owners only
      expect((await device.call<ServerInfo>("server.info", {})).remote?.pairingUrl).toBeUndefined();
      expect((await owner.call<ServerInfo>("server.info", {})).remote?.pairingUrl).toContain(TOKEN);
      // ordinary work is untouched
      expect(await device.call("settings.get", {})).toBeDefined();
      // the owner may revoke anyone
      expect(await owner.call("env.clients.revoke", { id: laptop.clientId })).toEqual({ ok: true });
    } finally {
      device.close();
      owner.close();
    }
  });

  it("the guard table itself", () => {
    const device = { clientId: "me" };
    expect(deviceGuard("env.pairingCode", {}, {})).toBeUndefined();
    expect(deviceGuard("env.pairingCode", {}, device)).toMatch(/owner/);
    expect(deviceGuard("env.clients.revoke", { id: "me" }, device)).toBeUndefined();
    expect(deviceGuard("env.clients.revoke", { id: "other" }, device)).toBeDefined();
    expect(deviceGuard("settings.set", { patch: { git: {} } }, device)).toBeUndefined();
    expect(deviceGuard("settings.set", { patch: { environment: { name: "x" } } }, device)).toBeUndefined();
    expect(deviceGuard("settings.set", { patch: { environment: { lanBind: false } } }, device)).toBeDefined();
    expect(deviceGuard("settings.set", { patch: { relay: null } }, device)).toBeDefined();
    for (const m of ["thread.create", "fs.browse", "pty.open", "env.updateHarnesses", "env.discover"]) expect(deviceGuard(m, {}, device)).toBeUndefined();
  });

  it("records lastUsedAt in clients.json when a device buys a ticket", async () => {
    const phone = await pairDevice("phone");
    const before = Date.now();
    const res = await fetch(`${base}/api/auth/ws-ticket`, { method: "POST", headers: { authorization: `Bearer ${phone.token}` } });
    expect(res.status).toBe(200);
    const file = JSON.parse(readFileSync(join(home, "clients.json"), "utf8")) as { clients: { id: string; lastUsedAt?: number }[] };
    expect(file.clients.find((c) => c.id === phone.clientId)?.lastUsedAt).toBeGreaterThanOrEqual(before);
  });
});

describe("Host check", () => {
  it("answers loopback, IP and allowed names; refuses others with 421 naming the env var", async () => {
    expect((await rawGet("/health", `127.0.0.1:${handle.port}`)).status).toBe(200);
    expect((await rawGet("/health", `localhost:${handle.port}`)).status).toBe(200);
    expect((await rawGet("/health", "tide.example.com")).status).toBe(200);
    const refused = await rawGet("/health", "evil.example");
    expect(refused.status).toBe(421);
    expect(refused.body).toContain("TIDE_ALLOWED_HOSTS");
  });

  it("refuses the WebSocket upgrade for an unknown Host", async () => {
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws?token=x`, { headers: { host: "evil.example" } });
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("error", () => undefined);
    });
    expect(status).toBe(421);
  });
});

describe("Origin rule on unauthenticated endpoints", () => {
  it("refuses pairing and webhooks from a public page; accepts no Origin, LAN and Tauri", async () => {
    const code = handle.pairing.issue().code;
    const evil = await pairWith(code, { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    expect((await fetch(`${base}/hook/some-hook-id`, { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" })).status).toBe(403);
    expect((await fetch(`${base}/hook/some-hook-id`, { method: "POST", body: "{}" })).status).toBe(404); // no Origin: reaches the handler
    expect((await pairWith(code, { origin: "tauri://localhost" })).status).toBe(200);
    expect((await pairWith(handle.pairing.issue().code, { origin: "http://10.0.0.8:5173" })).status).toBe(200);
    expect((await pairWith(handle.pairing.issue().code)).status).toBe(200);
  });

  it("accepts the relay's own origin only while a relay is configured", async () => {
    expect((await pairWith(handle.pairing.issue().code, { origin: "https://relay.example" })).status).toBe(403);
    relayUrl = "wss://relay.example";
    expect((await pairWith(handle.pairing.issue().code, { origin: "https://relay.example" })).status).toBe(200);
  });
});

describe("relayed pairing attempts", () => {
  it("share one stricter bucket only when the relay is configured", async () => {
    const relayed = { "x-tide-relay": "1" };
    // no relay configured: the header is ignored, the loopback address bucket (5/min) applies
    for (let i = 0; i < RELAY_PAIR_ATTEMPTS_PER_MINUTE + 1; i++) expect((await pairWith("000000", relayed)).status).toBe(401);
    await handle.close();
    store.close();
    store = new EventStore(await openDatabase(":memory:"));
    handle = await startServer({ engine: new Engine({ store }), store, config, relayState: () => ({ url: "wss://relay.example", connected: true, clientUrl: "https://relay.example/c/env-access" }) });
    base = `http://127.0.0.1:${handle.port}`;
    for (let i = 0; i < RELAY_PAIR_ATTEMPTS_PER_MINUTE; i++) expect((await pairWith("000000", relayed)).status).toBe(401);
    expect((await pairWith(handle.pairing.issue().code, relayed)).status).toBe(429);
    // a direct loopback request keeps its own bucket
    const direct = await pairWith(handle.pairing.issue().code);
    expect(direct.status).toBe(200);
    expect(handle.clientTokens.list().at(-1)?.lastAddress).not.toBe("relay");
  });
});
