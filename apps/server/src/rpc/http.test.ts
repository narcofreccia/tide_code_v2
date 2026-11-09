import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PairResponse, PairedClient } from "@tide/contracts";
import WebSocket from "ws";
import type { ServerConfig } from "../config.ts";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { signBody } from "../scheduling/webhooks.ts";
import { PROTOCOL_VERSION } from "../version.ts";
import { PairingCodes } from "./pairing.ts";
import { startServer, type ServerHandle } from "./server.ts";
import { WsTestClient } from "./testing/wsClient.ts";

const TOKEN = "http-test-token";
const config: ServerConfig = {
  tideHome: "/tmp/tide-http-test",
  dataDir: ":memory:",
  dbPath: ":memory:",
  environmentId: "env-http",
  token: TOKEN,
  host: "127.0.0.1",
  port: 0,
  dev: false,
  printToken: false,
  corsOrigins: [],
  version: "9.9.9-test",
  providers: {},
};

interface Booted {
  handle: ServerHandle;
  engine: Engine;
  store: EventStore;
  base: string;
  close(): Promise<void>;
}

async function boot(overrides: Partial<ServerConfig> = {}, pairing?: PairingCodes): Promise<Booted> {
  const store = new EventStore(await openDatabase(":memory:"));
  const engine = new Engine({ store });
  const handle = await startServer({ engine, store, config: { ...config, ...overrides }, ...(pairing !== undefined ? { pairing } : {}) });
  return {
    handle,
    engine,
    store,
    base: `http://127.0.0.1:${handle.port}`,
    async close() {
      await handle.close();
      store.close();
    },
  };
}

const pair = (base: string, code: unknown, name?: unknown): Promise<Response> =>
  fetch(`${base}/api/auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://elsewhere.example" },
    body: JSON.stringify(name === undefined ? { code } : { code, name }),
  });

const ticketFor = (b: Booted, token: string): Promise<Response> =>
  fetch(`${b.base}/api/auth/ws-ticket`, { method: "POST", headers: { authorization: `Bearer ${token}` } });

async function wsClient(b: Booted, token: string = TOKEN): Promise<WsTestClient> {
  const { ticket } = (await (await ticketFor(b, token)).json()) as { ticket: string };
  return WsTestClient.open(`ws://127.0.0.1:${b.handle.port}/ws?wsTicket=${ticket}`);
}

/** Pairs a device through the HTTP route; resolves with the minted token and id. */
async function pairDevice(b: Booted, name?: string): Promise<PairResponse> {
  const res = await pair(b.base, b.handle.pairing.issue().code, name);
  expect(res.status).toBe(200);
  return (await res.json()) as PairResponse;
}

describe("GET /api/env", () => {
  let b: Booted;
  beforeAll(async () => (b = await boot()));
  afterAll(() => b.close());

  it("answers without auth, with CORS *", async () => {
    const res = await fetch(`${b.base}/api/env`, { headers: { origin: "https://app.example" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ environmentId: "env-http", version: "9.9.9-test", protocol: PROTOCOL_VERSION });
    expect(typeof body["name"]).toBe("string");
  });

  it("answers a CORS preflight for the ticket route with *", async () => {
    const res = await fetch(`${b.base}/api/auth/ws-ticket`, { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("refuses a wrong bearer token for tickets", async () => {
    const res = await fetch(`${b.base}/api/auth/ws-ticket`, { method: "POST", headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  it("serves the pairing explainer at / when no web client is bundled", async () => {
    const res = await fetch(`${b.base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("tide pair");
    expect(html).not.toContain(TOKEN);
    expect((await fetch(`${b.base}/nope`)).status).toBe(404);
  });
});

describe("pairing", () => {
  it("issues a code over RPC and exchanges it once for a device token", async () => {
    const b = await boot();
    const client = await wsClient(b);
    try {
      const issued = await client.call<{ code: string; expiresAt: number; urls: string[] }>("env.pairingCode", {});
      expect(issued.code).toMatch(/^\d{6}$/);
      expect(issued.expiresAt).toBeGreaterThan(Date.now());
      expect(issued.urls).toEqual([`http://127.0.0.1:${b.handle.port}`]);
      const ok = await pair(b.base, issued.code);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("access-control-allow-origin")).toBe("*");
      const body = (await ok.json()) as PairResponse;
      expect(body).toMatchObject({ environmentId: "env-http", clientId: expect.any(String) });
      expect(body.token).not.toBe(TOKEN); // never the master token
      expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((await pair(b.base, issued.code)).status).toBe(401); // single use
    } finally {
      client.close();
      await b.close();
    }
  });

  it("rejects malformed bodies and expired codes", async () => {
    let now = 1_000_000;
    const codes = new PairingCodes({ now: () => now });
    const b = await boot({}, codes);
    try {
      expect((await pair(b.base, "12ab")).status).toBe(400);
      const bad = await fetch(`${b.base}/api/auth/pair`, { method: "POST", body: "not json" });
      expect(bad.status).toBe(400);
      const { code } = codes.issue();
      now += 5 * 60_000 + 1;
      expect((await pair(b.base, code)).status).toBe(401);
    } finally {
      await b.close();
    }
  });

  it("rate-limits to 5 attempts a minute per address", async () => {
    let now = 1_000_000;
    const codes = new PairingCodes({ now: () => now });
    const b = await boot({}, codes);
    try {
      for (let i = 0; i < 5; i++) expect((await pair(b.base, "000000")).status).toBe(401);
      const { code } = codes.issue();
      const limited = await pair(b.base, code);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
      now += 60_001;
      expect((await pair(b.base, code)).status).toBe(200);
    } finally {
      await b.close();
    }
  });
});

describe("paired devices (per-device tokens)", () => {
  // a fresh server per test: pairing is rate-limited to 5 attempts a minute per address
  let b: Booted;
  beforeEach(async () => (b = await boot()));
  afterEach(() => b.close());

  it("names the device, defaults the name, and refuses a name over 64 characters", async () => {
    const named = await pairDevice(b, "  Firefox on macOS  ");
    const plain = await pairDevice(b);
    expect((await pair(b.base, b.handle.pairing.issue().code, "x".repeat(65))).status).toBe(400);
    expect((await pair(b.base, b.handle.pairing.issue().code, 7)).status).toBe(400);
    const listed = b.handle.clientTokens.list();
    expect(listed.find((c) => c.id === named.clientId)?.name).toBe("Firefox on macOS");
    expect(listed.find((c) => c.id === plain.clientId)?.name).toBe("device");
  });

  it("a device token buys a ticket; the socket carries its client id; the master token still works", async () => {
    const device = await pairDevice(b, "phone");
    const res = await ticketFor(b, device.token);
    expect(res.status).toBe(200);
    const client = await wsClient(b, device.token);
    const master = await wsClient(b);
    try {
      const { clients } = await client.call<{ clients: PairedClient[] }>("env.clients.list", {});
      const me = clients.find((c) => c.id === device.clientId);
      expect(me).toMatchObject({ name: "phone", lastAddress: expect.stringContaining("127.0.0.1") });
      expect(clients.every((c) => !("hash" in c))).toBe(true);
      expect((await master.call<{ clients: PairedClient[] }>("env.clients.list", {})).clients.length).toBe(clients.length);
    } finally {
      client.close();
      master.close();
    }
  });

  it("never accepts a device token raw on the socket, even in --dev", async () => {
    const dev = await boot({ dev: true });
    try {
      const device = await pairDevice(dev);
      const code = await new Promise<number>((resolve) => new WebSocket(`ws://127.0.0.1:${dev.handle.port}/ws?token=${device.token}`).once("close", resolve));
      expect(code).toBe(4401);
    } finally {
      await dev.close();
    }
  });

  it("revoking closes the device's live sockets with 4401 and its token buys no more tickets", async () => {
    const device = await pairDevice(b, "lost phone");
    const other = await pairDevice(b, "keeper");
    const unused = (await (await ticketFor(b, device.token)).json()) as { ticket: string };
    const live = await wsClient(b, device.token);
    const bystander = await wsClient(b, other.token);
    const admin = await wsClient(b);
    try {
      expect(await admin.call("env.clients.revoke", { id: device.clientId })).toEqual({ ok: true });
      expect(await live.closed).toEqual({ code: 4401, reason: "revoked" });
      expect((await ticketFor(b, device.token)).status).toBe(401);
      // a ticket bought before the revoke dies with the device
      const late = await new Promise<number>((resolve) => new WebSocket(`ws://127.0.0.1:${b.handle.port}/ws?wsTicket=${unused.ticket}`).once("close", resolve));
      expect(late).toBe(4401);
      expect(await admin.call("env.clients.revoke", { id: device.clientId })).toEqual({ ok: false });
      // other devices are untouched
      expect((await bystander.call<{ clients: PairedClient[] }>("env.clients.list", {})).clients.some((c) => c.id === other.clientId)).toBe(true);
    } finally {
      bystander.close();
      admin.close();
    }
  });

  it("lets a device revoke itself", async () => {
    const device = await pairDevice(b, "self");
    const live = await wsClient(b, device.token);
    const revoked = live.call("env.clients.revoke", { id: device.clientId }).catch(() => "closed first");
    expect(await live.closed).toEqual({ code: 4401, reason: "revoked" });
    expect(["closed first", { ok: true }]).toContainEqual(await revoked);
    expect(b.handle.clientTokens.has(device.clientId as string)).toBe(false);
  });
});

describe("POST /hook/<hookId>", () => {
  let b: Booted;
  let projectId: string;
  beforeAll(async () => {
    b = await boot();
    const created = (await b.engine.dispatch({ type: "project.create", title: "P", rootPath: "/repo" })).events[0]?.event;
    if (created?.type !== "project.created") throw new Error("no project");
    projectId = created.project.id;
    await b.engine.dispatch({ type: "task.create", projectId, title: "Open", prompt: "triage it", schedule: { kind: "webhook", hookId: "open-hook-1" } });
    await b.engine.dispatch({ type: "task.create", projectId, title: "Signed", prompt: "deploy", schedule: { kind: "webhook", hookId: "signed-hook-1", secret: "s3cret" } });
  });
  afterAll(() => b.close());

  const fired = (): number => b.store.readAll().filter((r) => r.event.type === "task.fired").length;
  const hook = (id: string, body: string, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${b.base}/hook/${id}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

  it("fires an unsigned hook, appends the body to the prompt, and is idempotent per body", async () => {
    const before = fired();
    const res = await hook("open-hook-1", '{"issue":42}');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { threadId: string };
    expect(fired()).toBe(before + 1);
    const model = b.engine.getModel();
    const text = Object.values(model.messages).find((m) => m.threadId === body.threadId)?.text;
    expect(text).toBe('triage it\n\nWebhook payload:\n```json\n{"issue":42}\n```');
    expect((await hook("open-hook-1", '{"issue":42}')).status).toBe(200);
    expect(fired()).toBe(before + 1); // same payload: receipt replay
    expect((await hook("open-hook-1", '{"issue":43}')).status).toBe(200);
    expect(fired()).toBe(before + 2);
  });

  it("checks the HMAC when the task has a secret", async () => {
    const before = fired();
    const payload = '{"ref":"main"}';
    expect((await hook("signed-hook-1", payload)).status).toBe(401);
    expect((await hook("signed-hook-1", payload, { "x-tide-signature": signBody("wrong", payload) })).status).toBe(401);
    expect(fired()).toBe(before);
    expect((await hook("signed-hook-1", payload, { "x-tide-signature": signBody("s3cret", payload) })).status).toBe(200);
    expect(fired()).toBe(before + 1);
  });

  it("404s an unknown or paused hook and 413s an oversized body", async () => {
    expect((await hook("no-such-hook", "{}")).status).toBe(404);
    expect((await hook("open-hook-1", "x".repeat(64 * 1024 + 1))).status).toBe(413);
    const task = Object.values(b.engine.getModel().scheduledTasks).find((t) => t.title === "Open");
    await b.engine.dispatch({ type: "task.update", taskId: task?.id ?? "", enabled: false });
    expect((await hook("open-hook-1", '{"paused":true}')).status).toBe(404);
    expect((await fetch(`${b.base}/hook/open-hook-1`)).status).toBe(405);
  });
});

describe("static web client", () => {
  let dir: string;
  let b: Booted;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "tide-web-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Tide</title>");
    writeFileSync(join(dir, "assets", "app-abc.js"), "console.log(1)");
    writeFileSync(join(dir, "favicon.svg"), "<svg/>");
    writeFileSync(join(tmpdir(), "tide-secret.txt"), "outside");
    b = await boot({ webDir: dir });
  });
  afterAll(async () => {
    await b.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves files with their MIME type and index.html for client routes", async () => {
    const js = await fetch(`${b.base}/assets/app-abc.js`);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect(await js.text()).toBe("console.log(1)");
    expect((await fetch(`${b.base}/favicon.svg`)).headers.get("content-type")).toBe("image/svg+xml");
    for (const path of ["/", "/threads/abc", "/assets"]) {
      const res = await fetch(`${b.base}${path}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>Tide</title>");
    }
  });

  it("404s missing assets and never escapes the web root", async () => {
    expect((await fetch(`${b.base}/assets/gone.js`)).status).toBe(404);
    expect((await fetch(`${b.base}/missing.png`)).status).toBe(404);
    const escaped = await fetch(`${b.base}/..%2ftide-secret.txt`);
    expect(await escaped.text()).not.toContain("outside");
    expect((await fetch(`${b.base}/api/env`)).status).toBe(200); // routes win over the SPA fallback
  });
});
