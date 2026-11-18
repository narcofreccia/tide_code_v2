import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientCommand, rpcMethods, type DeviceAccess, type PairResponse, type PairedClient, type ServerInfo } from "@tide/contracts";
import WebSocket from "ws";
import type { ServerConfig } from "../config.ts";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { COMMAND_ACCESS, LIMITED_REFUSAL, METHOD_ACCESS, asksFullAccess } from "./deviceAccess.ts";
import { deviceGuard } from "./env.ts";
import { ClientTokenStore } from "./clientTokens.ts";
import { RELAY_PAIR_ATTEMPTS_PER_MINUTE } from "./pairing.ts";
import { startServer, type ServerHandle } from "./server.ts";
import { WsTestClient } from "./testing/wsClient.ts";

/** R18: owner vs paired-device powers, and the Host / Origin rules on the live listener. R19: device access levels. */

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

async function pairDevice(name: string, access?: DeviceAccess): Promise<PairResponse> {
  const code = handle.pairing.issue(access !== undefined ? { access } : {}).code;
  const res = await fetch(`${base}/api/auth/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: pairBody(code, name) });
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
    const phone = await pairDevice("phone", "full");
    const laptop = await pairDevice("laptop", "full");
    const device = await socket(phone.token);
    const owner = await socket(TOKEN);
    try {
      // env.pairingCode and env.clients.setAccess: owner only, even for a full-access device
      expect((await device.expectError("env.pairingCode", {})).code).toBe("forbidden");
      expect((await device.expectError("env.clients.setAccess", { id: phone.clientId, access: "full" })).code).toBe("forbidden");
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
    expect(deviceGuard("env.clients.setAccess", { id: "me", access: "full" }, device)).toMatch(/owner/);
    // a full-access device keeps ordinary work, terminals included
    for (const m of ["fs.browse", "pty.create", "env.updateHarnesses", "env.discover"]) expect(deviceGuard(m, {}, device, "full")).toBeUndefined();
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

describe("R19 access levels: the table", () => {
  const device = { clientId: "me" };
  const limited = (method: string, params: unknown = {}): string | undefined => deviceGuard(method, params, device, "limited");
  const dispatch = (command: Record<string, unknown>): { command: Record<string, unknown> } => ({ command: { commandId: "c1", ...command } });

  it("classifies every RPC method and every client command", () => {
    const commandTypes = (ClientCommand.anyOf as Array<{ properties: { type: { const: string } } }>).map((m) => m.properties.type.const);
    expect(commandTypes.length).toBeGreaterThan(40);
    expect(Object.keys(rpcMethods).filter((m) => !Object.hasOwn(METHOD_ACCESS, m))).toEqual([]);
    expect(commandTypes.filter((t) => !Object.hasOwn(COMMAND_ACCESS, t))).toEqual([]);
    // no stale rows for names the contracts dropped
    expect(Object.keys(METHOD_ACCESS).filter((m) => !Object.hasOwn(rpcMethods, m))).toEqual([]);
    expect(Object.keys(COMMAND_ACCESS).filter((t) => !commandTypes.includes(t))).toEqual([]);
  });

  it("refuses full-only work to a limited device", () => {
    for (const m of ["pty.create", "pty.attach", "pty.list", "fs.write", "fs.delete", "settings.set", "project.init", "run.start", "run.profiles.set", "env.updateHarnesses", "workspace.openExternal", "thread.terminalCommand", "fs.browse"]) {
      expect(limited(m), m).toBe(LIMITED_REFUSAL);
    }
    for (const type of ["project.create", "project.update", "project.link.add", "task.create", "task.run-now"]) expect(limited("orchestration.dispatch", dispatch({ type })), type).toBe(LIMITED_REFUSAL);
    // unknown names fail closed
    expect(limited("pty.something-new")).toBe(LIMITED_REFUSAL);
    expect(limited("orchestration.dispatch", dispatch({ type: "thread.something-new" }))).toBe(LIMITED_REFUSAL);
    expect(limited("orchestration.dispatch", {})).toBe(LIMITED_REFUSAL);
  });

  it("refuses full-access mode wherever a command carries a mode", () => {
    const full = "full-access";
    for (const command of [
      { type: "thread.create", projectId: "p", provider: "claude", mode: full },
      { type: "thread.update", threadId: "t", mode: full },
      { type: "plan.implement", planId: "x", target: "new", mode: full },
      { type: "team.run", projectId: "p", task: "x", team: { id: "t", name: "t", stages: [{ key: "a", role: "r", provider: "claude", worktree: "own" }, { key: "b", role: "r", provider: "codex", mode: full, worktree: "own" }] } },
    ]) {
      expect(limited("orchestration.dispatch", dispatch(command)), command.type).toMatch(/limited access and cannot use Full access mode/);
      expect(deviceGuard("orchestration.dispatch", dispatch(command), device, "full")).toBeUndefined();
      expect(deviceGuard("orchestration.dispatch", dispatch(command), {})).toBeUndefined();
    }
    expect(asksFullAccess({ mode: "auto" })).toBe(false);
  });

  it("lets a limited device read, chat, answer, review and merge", () => {
    for (const m of ["server.info", "model.subscribe", "fs.read", "fs.list", "fs.search", "vcs.threadDiff", "secret.provide", "pr.merge", "run.plan", "run.subscribe", "env.clients.list", "unsubscribe", "cancel"]) expect(limited(m), m).toBeUndefined();
    for (const command of [
      { type: "thread.create", projectId: "p", provider: "claude", mode: "approval-required" },
      { type: "thread.create", projectId: "p", provider: "claude" },
      { type: "turn.request", threadId: "t", text: "hi" },
      { type: "approval.respond", threadId: "t", requestId: "r", decision: "accept" },
      { type: "user-input.respond", threadId: "t", requestId: "r", answers: {} },
      { type: "thread.merge", threadId: "t" },
      { type: "thread.publish", threadId: "t" },
      { type: "thread.rollback", threadId: "t", turnId: "u", restoreFiles: true },
      { type: "thread.archive", threadId: "t" },
      { type: "thread.delete", threadId: "t" },
    ]) expect(limited("orchestration.dispatch", dispatch(command)), command.type).toBeUndefined();
  });
});

describe("R19 access levels: live", () => {
  it("pairs limited by default, tells the device its level, and applies a change on the next call", async () => {
    const phone = await pairDevice("phone");
    expect(phone.access).toBe("limited");
    const device = await socket(phone.token);
    const owner = await socket(TOKEN);
    try {
      expect((await device.call<ServerInfo>("server.info", {})).access).toBe("limited");
      expect((await owner.call<ServerInfo>("server.info", {})).access).toBeUndefined();
      expect((await device.call<{ clients: PairedClient[] }>("env.clients.list", {})).clients[0]?.access).toBe("limited");

      const refused = await device.expectError("pty.create", { cols: 80, rows: 24 });
      expect(refused).toMatchObject({ code: "forbidden", message: LIMITED_REFUSAL });
      expect((await device.expectError("pty.attach", { ptyId: "x" })).code).toBe("forbidden"); // streams are guarded too
      expect((await device.expectError("fs.write", { threadId: "t", path: "a", content: "" })).code).toBe("forbidden");
      expect((await device.expectError("settings.set", { patch: { environment: { name: "phone was here" } } })).code).toBe("forbidden");
      const mode = await device.expectError("orchestration.dispatch", { command: { type: "thread.create", commandId: "c1", projectId: "p", provider: "claude", mode: "full-access" } });
      expect(mode.code).toBe("forbidden");
      expect((await device.expectError("env.clients.setAccess", { id: phone.clientId, access: "full" })).code).toBe("forbidden");

      expect(await owner.call("env.clients.setAccess", { id: phone.clientId, access: "full" })).toEqual({ ok: true });
      expect(await owner.call("env.clients.setAccess", { id: "nobody", access: "full" })).toEqual({ ok: false });
      // same socket, next call
      const renamed = await device.call<{ environment: { name: string } }>("settings.set", { patch: { environment: { name: "phone was here" } } });
      expect(renamed.environment.name).toBe("phone was here");
      expect((await device.call<ServerInfo>("server.info", {})).access).toBe("full");
      const file = JSON.parse(readFileSync(join(home, "clients.json"), "utf8")) as { clients: { id: string; access?: string }[] };
      expect(file.clients.find((c) => c.id === phone.clientId)?.access).toBe("full");

      expect(await owner.call("env.clients.setAccess", { id: phone.clientId, access: "limited" })).toEqual({ ok: true });
      expect((await device.expectError("settings.set", { patch: { environment: { name: "again" } } })).code).toBe("forbidden");
    } finally {
      device.close();
      owner.close();
    }
  });

  it("the owner can mint a full-access code over RPC", async () => {
    const owner = await socket(TOKEN);
    try {
      const { code } = await owner.call<{ code: string }>("env.pairingCode", { access: "full" });
      const res = await pairWith(code);
      expect(((await res.json()) as PairResponse).access).toBe("full");
    } finally {
      owner.close();
    }
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
