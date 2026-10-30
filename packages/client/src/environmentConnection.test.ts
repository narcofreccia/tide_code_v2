import { afterEach, describe, expect, it } from "vitest";
import type { EnvProbe, EnvRoute } from "@tide/contracts";
import { EnvironmentConnection, type EnvironmentConnectionOptions } from "./environmentConnection.ts";
import type { FetchLike } from "./preflight.ts";
import { FakeServer, FakeTimers, waitFor } from "./testServer.ts";
import { httpOriginFor } from "./urls.ts";

const BACKOFF_MS = 7;
const INFO_MS = 30_001;
const UPGRADE_MS = 60_001;

type Answer = EnvProbe | "down" | number;

/** `/api/env` answers by origin; `ws-ticket` answers with `ticket` (or a status). */
function fakeFetch(table: Record<string, Answer>, ticket: string | number = "tk"): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const origin = new URL(url).origin;
    if (url.endsWith("/api/auth/ws-ticket")) {
      if (typeof ticket === "number") return { ok: false, status: ticket, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ ticket }) };
    }
    const answer = table[origin] ?? "down";
    if (answer === "down") throw new TypeError("fetch failed");
    if (typeof answer === "number") return { ok: false, status: answer, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => answer };
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const probe = (environmentId: string): EnvProbe => ({ environmentId, name: environmentId, version: "0.0.0", protocol: 1 });
const route = (url: string, priority: number, kind: EnvRoute["kind"] = "lan"): EnvRoute => ({ kind, url, priority });

const servers: FakeServer[] = [];
const conns: EnvironmentConnection[] = [];

async function server(): Promise<FakeServer> {
  const s = await FakeServer.start();
  s.handler = (req, sock) => {
    if (req.method === "server.info") s.send(sock, { id: req.id, result: { environmentId: "env-1", name: "box", version: "0", startedAt: 1 } });
    if (req.method === "model.subscribe") s.send(sock, { id: req.id, chunk: { kind: "snapshot", model: { ...emptyish(), seq: 3 } } });
  };
  servers.push(s);
  return s;
}

function emptyish(): Record<string, unknown> {
  return {
    projects: {}, threads: {}, turns: {}, messages: {}, activities: {}, plans: {}, expertsSessions: {},
    expertsFindings: {}, expertsMessages: {}, handoffs: {}, scheduledTasks: {}, threadMessages: {}, threadTimeline: {},
  };
}

function connect(over: Partial<EnvironmentConnectionOptions> & Pick<EnvironmentConnectionOptions, "routes" | "fetchImpl">, timers = new FakeTimers()) {
  const conn = new EnvironmentConnection({
    id: "env-1",
    token: "tok",
    authMode: "token",
    timers: timers.timers,
    random: () => 0,
    backoff: { minMs: BACKOFF_MS, maxMs: BACKOFF_MS * 4, jitter: 0 },
    infoIntervalMs: INFO_MS,
    upgradeIntervalMs: UPGRADE_MS,
    ...over,
  });
  conns.push(conn);
  conn.start();
  return { conn, timers };
}

afterEach(async () => {
  for (const c of conns.splice(0)) c.stop();
  for (const s of servers.splice(0)) await s.stop();
});

describe("EnvironmentConnection", () => {
  it("skips a route whose /api/env names another environment and connects on the next", async () => {
    const good = await server();
    const wrong = "ws://10.9.9.9:3777/ws";
    const fetchImpl = fakeFetch({ [httpOriginFor(wrong)]: probe("someone-else"), [httpOriginFor(good.url)]: probe("env-1") });
    const { conn } = connect({ routes: [route(good.url, 10), route(wrong, 0)], fetchImpl });
    await waitFor(() => conn.snapshot.state === "connected");
    expect(conn.snapshot.route?.url).toBe(good.url);
    expect(good.urls[0]).toContain("token=tok");
    await waitFor(() => conn.snapshot.info?.environmentId === "env-1");
  });

  it("stays offline with a retry pending when no route answers", async () => {
    const fetchImpl = fakeFetch({});
    const { conn, timers } = connect({ routes: [route("ws://10.1.1.1:1/ws", 0)], fetchImpl });
    await waitFor(() => conn.snapshot.state === "offline");
    expect(timers.pending()).toContain(BACKOFF_MS);
    await expect(conn.call("server.info", {})).rejects.toMatchObject({ code: "disconnected" });
  });

  it("goes unauthorized on close code 4401 and does not retry until the token changes", async () => {
    const s = await server();
    s.onConnect = (sock) => sock.close(4401, "unauthorized");
    const fetchImpl = fakeFetch({ [httpOriginFor(s.url)]: probe("env-1") });
    const { conn, timers } = connect({ routes: [route(s.url, 0)], fetchImpl });
    await waitFor(() => conn.snapshot.state === "unauthorized");
    expect(timers.pending()).not.toContain(BACKOFF_MS);
    expect(s.urls).toHaveLength(1);
    await expect(conn.call("server.info", {})).rejects.toMatchObject({ code: "unauthorized" });

    s.onConnect = () => undefined;
    conn.setToken("fresh");
    await waitFor(() => conn.snapshot.state === "connected");
    expect(s.urls[1]).toContain("token=fresh");
  });

  it("treats a refused ws-ticket as unauthorized", async () => {
    const s = await server();
    const fetchImpl = fakeFetch({ [httpOriginFor(s.url)]: probe("env-1") }, 401);
    const { conn } = connect({ routes: [route(s.url, 0)], fetchImpl, authMode: "ticket" });
    await waitFor(() => conn.snapshot.state === "unauthorized");
    expect(s.urls).toHaveLength(0);
  });

  it("buys a ticket on the route's own origin in ticket mode", async () => {
    const s = await server();
    const fetchImpl = fakeFetch({ [httpOriginFor(s.url)]: probe("env-1") }, "tk-9");
    const { conn } = connect({ routes: [route(s.url, 0)], fetchImpl, authMode: "ticket" });
    await waitFor(() => conn.snapshot.state === "connected");
    expect(fetchImpl.calls).toContain(`${httpOriginFor(s.url)}/api/auth/ws-ticket`);
    expect(s.urls[0]).toContain("wsTicket=tk-9");
  });

  it("on a drop goes offline, backs off, and resumes the model with fromSeq", async () => {
    const s = await server();
    const fetchImpl = fakeFetch({ [httpOriginFor(s.url)]: probe("env-1") });
    const { conn, timers } = connect({ routes: [route(s.url, 0)], fetchImpl });
    await waitFor(() => conn.store.getState().model.seq === 3);

    s.dropClients();
    await waitFor(() => conn.snapshot.state === "offline");
    expect(conn.store.getState().status).not.toBe("open");
    expect(timers.run(BACKOFF_MS)).toBe(1);

    await waitFor(() => conn.snapshot.state === "connected");
    await waitFor(() => s.requests.filter((r) => r.method === "model.subscribe").length === 2);
    const resumed = s.requests.filter((r) => r.method === "model.subscribe")[1];
    expect(resumed?.params).toEqual({ fromSeq: 3 });
  });

  it("falls back to a local route whose preflight fails (CORS / pre-R9 server) and adopts its id", async () => {
    const s = await server();
    const fetchImpl = fakeFetch({});
    const { conn } = connect({ id: "local", verifyId: false, routes: [route(s.url, 0, "local")], fetchImpl });
    await waitFor(() => conn.snapshot.state === "connected");
    await waitFor(() => conn.snapshot.environmentId === "env-1");
  });

  it("moves to a better route when it starts answering", async () => {
    const far = await server();
    const near = await server();
    const table: Record<string, Answer> = { [httpOriginFor(far.url)]: probe("env-1") };
    const fetchImpl = fakeFetch(table);
    const { conn, timers } = connect({ routes: [route(near.url, 0), route(far.url, 20, "tailscale")], fetchImpl });
    await waitFor(() => conn.snapshot.state === "connected");
    expect(conn.snapshot.route?.url).toBe(far.url);
    await waitFor(() => far.requests.some((r) => r.method === "model.subscribe"));

    table[httpOriginFor(near.url)] = probe("env-1");
    expect(timers.run(UPGRADE_MS)).toBe(1);
    await waitFor(() => conn.snapshot.route?.url === near.url);
    await waitFor(() => near.requests.some((r) => r.method === "model.subscribe"));
    expect(near.requests.find((r) => r.method === "model.subscribe")?.params).toEqual({ fromSeq: 3 });
    await waitFor(() => far.sockets.length === 0);
  });

  it("waits for the first connection before sending a call", async () => {
    const s = await server();
    const fetchImpl = fakeFetch({ [httpOriginFor(s.url)]: probe("env-1") });
    const { conn } = connect({ routes: [route(s.url, 0)], fetchImpl });
    const info = await conn.call("server.info", {});
    expect(info.environmentId).toBe("env-1");
  });
});
