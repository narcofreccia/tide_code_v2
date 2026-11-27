import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../config.ts";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { startServer, type ServerHandle } from "../rpc/server.ts";
import { ELEVATION_REQUIRED } from "./elevation.ts";

const master = "test-master";
const secret = "test-elevation-secret";
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "tide-http-mcp-")));
const roots = join(sandbox, "projects");
const outside = join(sandbox, "outside");
const config: ServerConfig = {
  tideHome: sandbox, dataDir: ":memory:", dbPath: ":memory:", environmentId: "mcp-test",
  token: master, host: "127.0.0.1", port: 0, dev: true, printToken: false, corsOrigins: [],
  version: "test-version", providers: {},
};

let store: EventStore;
let engine: Engine;
let server: ServerHandle;
let projectId: string;
let base: string;
let relayConfigured = true;

beforeAll(async () => {
  mkdirSync(roots);
  mkdirSync(outside);
  symlinkSync(outside, join(roots, "escape"), "dir");
  symlinkSync(roots, join(outside, "inward"), "dir");
  vi.stubEnv("TIDE_MCP_ELEVATION_SECRET", secret);
  vi.stubEnv("TIDE_MCP_ALLOWED_IPS", "192.0.2.10");
  store = new EventStore(await openDatabase(":memory:"));
  engine = new Engine({ store });
  const created = (await engine.dispatch({ type: "project.create", title: "Existing", rootPath: roots })).events[0]?.event;
  if (created?.type !== "project.created") throw new Error("Could not seed project");
  projectId = created.project.id;
  server = await startServer({
    config, store, engine, mcpAllowedRoots: [roots],
    relayState: () => relayConfigured ? { url: "https://relay.example.test", connected: true } : undefined,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server?.close();
  store?.close();
  vi.unstubAllEnvs();
  rmSync(sandbox, { recursive: true, force: true });
});

function elevation(key = secret): string {
  const payload = `v1.user-42.${Math.floor(Date.now() / 1000) + 60}.${randomBytes(16).toString("hex")}`;
  return `${payload}.${createHmac("sha256", key).update(payload, "utf8").digest("hex")}`;
}

function relayRequest(body: string, token: string | null, relay: boolean, elevationToken?: string) {
  return new Promise<{ status: number | undefined; text: string }>((resolve, reject) => {
    const req = request(`${base}/mcp`, {
      method: "POST",
      headers: {
        Host: `127.0.0.1:${server.port}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(relay ? { "x-tide-relay": "1" } : {}),
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        ...(elevationToken === undefined ? {} : { "X-Tide-Elevation-Token": elevationToken }),
      },
    }, (res) => {
      res.setEncoding("utf8");
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

function rpc(method: string, params?: object, token: string | null = master, relay = true, elevationToken?: string) {
  return relayRequest(JSON.stringify({ jsonrpc: "2.0", method, ...(method.startsWith("notifications/") ? {} : { id: 42 }), params }), token, relay, elevationToken);
}

async function call(name: string, args = {}, elevationToken?: string, token = master) {
  const { status, text } = await rpc("tools/call", { name, arguments: args }, token, true, elevationToken);
  expect(status).toBe(200);
  const result = JSON.parse(text).result;
  if (!result.isError) expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  return result;
}

function expectElevationRequired(result: unknown) {
  expect(result).toEqual({ isError: true, content: [{ type: "text", text: ELEVATION_REQUIRED }] });
}

describe("remote MCP", () => {
  it("requires a bearer and applies the IP allowlist except to configured loopback relay traffic", async () => {
    expect((await rpc("initialize", {}, null)).status).toBe(401);
    expect((await rpc("initialize", {}, "wrong")).status).toBe(401);
    expect((await rpc("initialize", {}, master, false)).status).toBe(403);
    relayConfigured = false;
    try {
      expect((await rpc("initialize")).status).toBe(403);
    } finally {
      relayConfigured = true;
    }
    for (const version of ["2025-03-26", "2025-06-18", "2025-11-25", "unsupported"]) {
      const response = await rpc("initialize", { protocolVersion: version });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.text)).toEqual({
        jsonrpc: "2.0", id: 42,
        result: {
          protocolVersion: version === "unsupported" ? "2025-03-26" : version,
          capabilities: { tools: {} }, serverInfo: { name: "Tide Code", version: config.version },
        },
      });
    }
    expect(await rpc("notifications/initialized")).toEqual({ status: 202, text: "" });
  });

  it("lists the complete tool catalog and enforces the body limit", async () => {
    const response = await rpc("tools/list");
    const tools = JSON.parse(response.text).result.tools as { name: string; description: string; inputSchema: { type: string } }[];
    expect(tools.map((tool) => tool.name)).toEqual([
      "tide_projects_list", "tide_harnesses", "tide_thread_list", "tide_thread_read", "tide_thread_wait",
      "tide_vcs_status", "tide_thread_diff", "tide_thread_create", "tide_thread_send", "tide_thread_interrupt",
      "tide_thread_archive", "tide_pending_list", "tide_pending_respond", "tide_approvals_list",
      "tide_approval_respond", "tide_list_scheduled_tasks", "tide_project_create",
    ]);
    expect(tools.every((tool) => tool.description.length > 0 && tool.inputSchema.type === "object")).toBe(true);
    expect((await relayRequest(" ".repeat(1024 * 1024 + 1), master, true)).status).toBe(413);
    expect(JSON.parse((await relayRequest("{", master, true)).text).error.code).toBe(-32700);
  });

  it("mints a revocable, scoped token for Tide AI Chat using only master authorization", async () => {
    const url = `${base}/api/mcp/info`;
    expect((await fetch(url)).status).toBe(401);
    const pair = await fetch(url, { headers: { authorization: `Bearer ${master}` } });
    expect(pair.status).toBe(200);
    expect(pair.headers.get("cache-control")).toBe("no-store");
    const { token, clientId, elevationSecret, environmentId } = (await pair.json()) as {
      token: string;
      clientId: string;
      elevationSecret: string;
      environmentId: string;
    };
    expect({ elevationSecret, environmentId }).toEqual({ elevationSecret: secret, environmentId: config.environmentId });
    expect(server.clientTokens.list()).toContainEqual(expect.objectContaining({ id: clientId, name: "Tide AI Chat MCP" }));
    const headers = { authorization: `Bearer ${token}` };
    expect((await fetch(url, { headers })).status).toBe(401);
    expect((await fetch(`${base}/api/auth/ws-ticket`, { method: "POST", headers })).status).toBe(401);
    expect((await call("tide_projects_list", {}, undefined, token)).structuredContent.projects).toContainEqual({
      id: projectId, cwd: roots, name: "Existing", threadCount: 0,
    });
    expect(server.clientTokens.revoke(clientId)).toBe(true);
    expect((await rpc("tools/list", {}, token)).status).toBe(401);
    const ordinary = server.clientTokens.mint("Phone", "loopback");
    expect((await rpc("tools/list", {}, ordinary.token)).status).toBe(200);
  });

  it("creates and lists approval-required threads without elevation, including the initial prompt", async () => {
    const result = await call("tide_thread_create", { projectId, title: "Safe thread", provider: "claude", mode: "approval-required", prompt: "Hello" });
    const { threadId, turnId } = result.structuredContent;
    expect(engine.getModel().threads[threadId]?.mode).toBe("approval-required");
    expect(engine.getModel().turns[turnId]?.threadId).toBe(threadId);
    const listed = await call("tide_thread_list", { projectId, title: "SAFE" });
    expect(listed.structuredContent.serverNowIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(listed.structuredContent.threads).toMatchObject([
      { id: threadId, title: "Safe thread", mode: "approval-required", requiresElevation: false },
    ]);
    await call("tide_thread_send", { threadId, text: "Second", mode: "queue" });
    await call("tide_thread_send", { threadId, text: "Third", mode: "queue" });
    const tailRead = await call("tide_thread_read", { threadId, limit: 2 });
    expect(tailRead.structuredContent.totalItems).toBe(3);
    expect(tailRead.structuredContent.hasOlder).toBe(true);
    expect(tailRead.structuredContent.items.map((i: { text: string }) => i.text)).toEqual(["Second", "Third"]);
    const headRead = await call("tide_thread_read", { threadId, limit: 2, fromEnd: false });
    expect(headRead.structuredContent.items.map((i: { text: string }) => i.text)).toEqual(["Hello", "Second"]);
    const vcs = await call("tide_vcs_status", { threadId });
    expect(vcs.structuredContent).toMatchObject({ cwd: roots, isRepo: false, worktree: false, dirty: 0 });
    const approvals = await call("tide_approvals_list", { threadId });
    expect(approvals.structuredContent).toEqual({ approvals: [] });
    const waited = await call("tide_thread_wait", { threadId, timeoutMs: 1000 });
    expect(waited.structuredContent.serverNowIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("requires fresh elevation to create and send to full-access threads", async () => {
    const input = { projectId, provider: "claude", mode: "full-access", prompt: "First" };
    expectElevationRequired(await call("tide_thread_create", input));
    expectElevationRequired(await call("tide_thread_create", input, elevation("wrong")));
    const token = elevation();
    const created = await call("tide_thread_create", input, token);
    const { threadId, turnId } = created.structuredContent;
    expect(engine.getModel().threads[threadId]?.mode).toBe("full-access");
    expect(engine.getModel().turns[turnId]?.threadId).toBe(threadId);
    const send = { threadId, text: "Follow-up", mode: "queue" };
    expectElevationRequired(await call("tide_thread_send", send));
    expectElevationRequired(await call("tide_thread_send", send, token));
    expectElevationRequired(await call("tide_thread_send", send, elevation("wrong")));
    const sent = await call("tide_thread_send", send, elevation());
    expect(engine.getModel().turns[sent.structuredContent.turnId]?.threadId).toBe(threadId);
  });

  it("requires elevation to create projects and rejects traversal, external roots and symlinks", async () => {
    expectElevationRequired(await call("tide_project_create", { name: "new-repo" }));
    expectElevationRequired(await call("tide_project_create", { name: "new-repo" }, elevation("wrong")));
    for (const args of [
      { name: "../outside" }, { name: "bad..name" }, { name: outside },
      { name: "bad", root: outside }, { name: "bad", root: `${roots}/../outside` },
      { name: "bad", root: join(roots, "escape") }, { name: "escape" },
      { name: "bad", root: join(outside, "inward") },
    ]) {
      expect(await call("tide_project_create", args, elevation())).toMatchObject({ isError: true });
    }
    expect(existsSync(join(outside, "bad"))).toBe(false);
    const created = await call("tide_project_create", { name: "new-repo" }, elevation());
    const rootPath = join(roots, "new-repo");
    expect(created.structuredContent.rootPath).toBe(rootPath);
    expect(engine.getModel().projects[created.structuredContent.projectId]?.rootPath).toBe(rootPath);
    expect(existsSync(join(rootPath, ".git"))).toBe(true);
    const plain = await call("tide_project_create", { name: "plain", gitInit: false }, elevation());
    expect(plain.structuredContent.rootPath).toBe(join(roots, "plain"));
    expect(existsSync(join(roots, "plain", ".git"))).toBe(false);
  });
});
