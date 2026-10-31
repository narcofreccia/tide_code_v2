import { describe, expect, it } from "vitest";
import type { ReadModel, RunRepo, RunService, RunSessionChunk } from "@tide/contracts";
import type { HostListener, ListeningPort } from "../workspace/ports.ts";
import { fakeBackend } from "../workspace/pty/fakeBackend.ts";
import type { TreeSignal } from "../workspace/pty/killTree.ts";
import { PtyManager } from "../workspace/pty/manager.ts";
import { RunSupervisor } from "./supervisor.ts";

/** Manual clock shared by the pty command delay and the supervisor's sleeps. */
function clock() {
  let now = 0;
  let timers: { at: number; fn: () => void }[] = [];
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  const schedule = (fn: () => void, ms: number): (() => void) => {
    const t = { at: now + ms, fn };
    timers.push(t);
    return () => {
      timers = timers.filter((x) => x !== t);
    };
  };
  return {
    now: () => now,
    schedule,
    sleep: (ms: number) => new Promise<void>((resolve) => void schedule(resolve, ms)),
    flush,
    /** advances in steps so timers registered by a fired timer (poll loops) run at their own time */
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        await flush();
        const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (next === undefined) break;
        now = next.at;
        timers = timers.filter((t) => t !== next);
        next.fn();
      }
      now = end;
      await flush();
    },
  };
}

const svc = (id: string, over: Partial<RunService> = {}): RunService => ({
  id,
  name: id,
  command: `run-${id}`,
  listens: [],
  connects: [],
  env: {},
  readiness: { kind: "none" },
  ...over,
});
const repo = (repoKey: string, services: RunService[]): RunRepo => ({
  repoId: repoKey === "backend" ? "root" : repoKey,
  repoKey,
  path: `/src/${repoKey}`,
  label: repoKey,
  stale: false,
  profile: { version: 1, repoKey, services, source: "manifest", manifestHash: "h", generatedAt: 0, warnings: [] },
});

function setup(repos: RunRepo[]) {
  const c = clock();
  const fake = fakeBackend();
  const ptys = new PtyManager({ backend: fake.backend, schedule: c.schedule, sleep: c.sleep, children: async () => [1] });
  const state = { listeners: [] as HostListener[], owned: [] as ListeningPort[], listCalls: [] as { pids: number[]; fresh: boolean | undefined }[] };
  const killed: [number, TreeSignal][] = [];
  const alivePids = new Set<number>();
  const model = { projects: { p1: { id: "p1", title: "P", rootPath: "/src/backend", createdAt: 0, updatedAt: 0 } } } as unknown as ReadModel;
  const sup = new RunSupervisor({
    ptys,
    ports: {
      list: async (pids, options) => {
        state.listCalls.push({ pids, fresh: options?.fresh });
        return state.owned;
      },
      listeners: async () => state.listeners,
    },
    profilesFor: async () => repos,
    model: () => model,
    now: c.now,
    sleep: c.sleep,
    host: () => "10.0.0.2",
    killPid: async (pid, signal) => {
      killed.push([pid, signal]);
      alivePids.delete(pid);
    },
    pidAlive: (pid) => alivePids.has(pid),
    realpath: async (p) => p,
  });
  const chunks: RunSessionChunk[] = [];
  sup.subscribe("p1", (chunk) => chunks.push(chunk));
  const settle = async (): Promise<void> => {
    await c.flush();
    await sup.drain();
    await c.flush();
  };
  return { c, fake, ptys, sup, state, chunks, killed, alivePids, model, settle };
}

const stateOf = (sup: RunSupervisor, key: string) => sup.get("p1")?.services[key];

describe("RunSupervisor", () => {
  it("creates one run-owned terminal per service with the rendered env and command", async () => {
    const api = svc("api", { command: "uvicorn app:app --port 8000", listens: [{ name: "http", port: 8000, how: "flag", flag: "--port" }], env: { DEBUG: "1" } });
    const web = svc("web", { command: "pnpm dev", connects: [{ env: "VITE_API_URL", to: "backend.api", template: "http://${host}:${port}" }] });
    const t = setup([repo("backend", [api]), repo("frontend", [web])]);
    t.state.listeners = [{ port: 8000, pid: 9, command: "python", cwd: "/elsewhere" }];
    const session = await t.sup.start("p1");
    await t.settle();
    expect(Object.keys(session.services)).toEqual(["backend.api", "frontend.web"]);
    expect(t.fake.handles).toHaveLength(2);
    const [apiPty, webPty] = t.fake.handles;
    expect(apiPty?.spec.cwd).toBe("/src/backend");
    expect(apiPty?.spec.env["DEBUG"]).toBe("1");
    expect(webPty?.spec.env["VITE_API_URL"]).toBe("http://10.0.0.2:8001");
    expect(t.ptys.list("run:p1").map((p) => p.label)).toEqual(["api", "web"]);
    await t.c.advance(300);
    expect(apiPty?.written).toEqual([" uvicorn app:app --port 8001; exit\n"]);
    expect(stateOf(t.sup, "backend.api")).toMatchObject({ state: "starting", pid: apiPty?.pid, ports: { http: 8001 } });
  });

  it("starts a service only after its dependency is up", async () => {
    const t = setup([repo("backend", [svc("celery", { dependsOn: ["redis"] }), svc("redis")])]);
    await t.sup.start("p1");
    await t.settle();
    expect(t.fake.handles.map((h) => h.spec.env["TIDE_RUN_PROJECT_ID"])).toEqual(["p1"]);
    expect(stateOf(t.sup, "backend.celery")).toMatchObject({ state: "starting", reason: "waiting for backend.redis" });
    await t.c.advance(2000);
    await t.settle();
    expect(stateOf(t.sup, "backend.redis")?.state).toBe("running");
    expect(t.fake.handles).toHaveLength(2);
    expect(stateOf(t.sup, "backend.celery")?.reason).toBeUndefined();
  });

  it("fails a dependent when its dependency fails", async () => {
    const t = setup([repo("backend", [svc("redis"), svc("celery", { dependsOn: ["redis"] })])]);
    await t.sup.start("p1");
    await t.settle();
    t.fake.handles[0]?.exit(1);
    await t.settle();
    expect(stateOf(t.sup, "backend.redis")).toMatchObject({ state: "failed", reason: "exited", exit: { code: 1 } });
    expect(stateOf(t.sup, "backend.celery")).toMatchObject({ state: "failed", reason: "dependency backend.redis failed" });
    expect(t.fake.handles).toHaveLength(1);
  });

  it("becomes ready when the log pattern appears", async () => {
    const t = setup([repo("frontend", [svc("web", { readiness: { kind: "log", pattern: "ready in \\d+" } })])]);
    await t.sup.start("p1");
    await t.settle();
    t.fake.handles[0]?.data("VITE v6 \x1b[1mready\x1b[22m in ");
    expect(stateOf(t.sup, "frontend.web")?.state).toBe("starting");
    t.fake.handles[0]?.data("312 ms");
    expect(stateOf(t.sup, "frontend.web")?.state).toBe("ready");
  });

  it("becomes ready when the assigned port shows up under the terminal", async () => {
    const t = setup([repo("backend", [svc("api", { listens: [{ name: "http", port: 8000, how: "env", envVar: "PORT" }], readiness: { kind: "port" } })])]);
    await t.sup.start("p1");
    await t.settle();
    await t.c.advance(1000);
    expect(stateOf(t.sup, "backend.api")?.state).toBe("starting");
    expect(t.state.listCalls).toEqual([{ pids: [t.fake.handles[0]?.pid], fresh: true }]);
    t.state.owned = [{ port: 8000, pid: 5, command: "python", url: "http://127.0.0.1:8000" }];
    await t.c.advance(1000);
    expect(stateOf(t.sup, "backend.api")?.state).toBe("ready");
  });

  it("fails with timeout after 60 s without readiness and keeps the process", async () => {
    const t = setup([repo("backend", [svc("api", { readiness: { kind: "log", pattern: "never" } })])]);
    await t.sup.start("p1");
    await t.settle();
    await t.c.advance(60_000);
    expect(stateOf(t.sup, "backend.api")).toMatchObject({ state: "failed", reason: "timeout" });
    expect(t.fake.handles[0]?.signals).toEqual([]);
    expect(t.ptys.alive(stateOf(t.sup, "backend.api")?.ptyId ?? "")).toBe(true);
  });

  it("stops with SIGINT, SIGTERM, SIGKILL 3 s apart, then drops the session", async () => {
    const t = setup([repo("backend", [svc("api")])]);
    await t.sup.start("p1");
    await t.settle();
    const stopping = t.sup.stop("p1");
    await t.c.advance(0);
    expect(t.fake.handles[0]?.signals).toEqual(["SIGINT"]);
    await t.c.advance(3000);
    expect(t.fake.handles[0]?.signals).toEqual(["SIGINT", "SIGTERM"]);
    await t.c.advance(3000);
    await stopping;
    expect(t.fake.handles[0]?.signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(t.sup.get("p1")).toBeUndefined();
    const tail = t.chunks.slice(-2);
    expect(tail[0]).toMatchObject({ kind: "service", key: "backend.api", status: { state: "exited", exit: { signal: "SIGKILL" } } });
    expect(tail[1]).toEqual({ kind: "ended" });
  });

  it("streams an exit after the service ran", async () => {
    const t = setup([repo("backend", [svc("api")])]);
    await t.sup.start("p1");
    await t.settle();
    await t.c.advance(6000);
    expect(stateOf(t.sup, "backend.api")?.state).toBe("running");
    t.fake.handles[0]?.exit(0);
    expect(t.chunks.at(-1)).toMatchObject({ kind: "service", key: "backend.api", status: { state: "exited", exit: { code: 0 } } });
    expect(t.chunks[0]).toEqual({ kind: "snapshot", session: { projectId: "p1", startedAt: 0, services: {} } });
  });

  it("fails fast with port-taken on the bind error and stops the terminal", async () => {
    const t = setup([repo("frontend", [svc("web", { readiness: { kind: "port" }, listens: [{ name: "http", port: 8081, how: "flag", flag: "--port" }] })])]);
    await t.sup.start("p1");
    await t.settle();
    t.fake.handles[0]?.data("error: Port 8081 is in use\r\n");
    expect(stateOf(t.sup, "frontend.web")).toMatchObject({ state: "failed", reason: "port-taken" });
    await t.c.advance(0);
    expect(t.fake.handles[0]?.signals).toEqual(["SIGINT"]);
  });

  it("refuses a blocked stack unless forced, and force starts the rest", async () => {
    const tauri = (id: string) => svc(id, { listens: [{ name: "http", port: 1420, how: "fixed" }] });
    const t = setup([repo("reel", [tauri("gui")]), repo("pos2", [tauri("app")])]);
    await expect(t.sup.start("p1")).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("reel.gui") });
    const session = await t.sup.start("p1", { force: true });
    await t.settle();
    expect(Object.keys(session.services)).toEqual(["reel.gui"]);
    expect(session.plan?.rows.find((r) => r.key === "pos2.app")?.blocked).toBeDefined();
  });

  it("marks a service listening from inside its repo as external, keeps its port and stops it", async () => {
    const api = svc("api", { listens: [{ name: "http", port: 8000, how: "env", envVar: "PORT" }] });
    const t = setup([repo("backend", [api, svc("worker")])]);
    t.state.listeners = [{ port: 8000, pid: 4242, command: "python", cwd: "/src/backend/app" }];
    t.alivePids.add(4242);
    await t.sup.markExternal("p1");
    expect(stateOf(t.sup, "backend.api")).toMatchObject({ state: "external", pid: 4242, ports: { http: 8000 } });
    const plan = await t.sup.plan("p1");
    expect(plan.rows.find((r) => r.key === "backend.api")?.ports).toEqual({ http: 8000 });
    await t.sup.start("p1");
    await t.settle();
    expect(t.fake.handles).toHaveLength(1); // only the worker
    await t.sup.stop("p1", "backend.api");
    expect(t.killed).toEqual([[4242, "SIGINT"]]);
    expect(stateOf(t.sup, "backend.api")).toMatchObject({ state: "exited", reason: "stopped" });
  });

  it("restarts one service on a fresh terminal", async () => {
    const t = setup([repo("backend", [svc("api")])]);
    await t.sup.start("p1");
    await t.settle();
    t.fake.handles[0]?.diesOn.add("SIGINT");
    const session = await t.sup.restart("p1", "backend.api");
    await t.settle();
    expect(t.fake.handles).toHaveLength(2);
    expect(session.services["backend.api"]).toMatchObject({ state: "starting" });
    expect(stateOf(t.sup, "backend.api")?.ptyId).not.toBe(undefined);
  });
});
