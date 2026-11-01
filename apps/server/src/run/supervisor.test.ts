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

interface SetupOptions {
  threads?: Record<string, { projectId: string; worktreePath?: string; branch?: string }>;
  exists?: (path: string) => Promise<boolean>;
  provision?: (sourceRoot: string, worktreePath: string) => Promise<unknown>;
}

/** The root repo moved to `rootPath` when the supervisor asks for a worktree. */
const atRoot = (repos: RunRepo[], rootPath: string | undefined): RunRepo[] =>
  rootPath === undefined ? repos : repos.map((r) => (r.repoId === "root" ? { ...r, path: rootPath } : r));

function setup(repos: RunRepo[], opts: SetupOptions = {}) {
  const c = clock();
  const fake = fakeBackend();
  const ptys = new PtyManager({ backend: fake.backend, schedule: c.schedule, sleep: c.sleep, children: async () => [1] });
  const state = { listeners: [] as HostListener[], owned: [] as ListeningPort[], listCalls: [] as { pids: number[]; fresh: boolean | undefined }[] };
  const killed: [number, TreeSignal][] = [];
  const alivePids = new Set<number>();
  const model = { projects: { p1: { id: "p1", title: "P", rootPath: "/src/backend", createdAt: 0, updatedAt: 0 } }, threads: opts.threads ?? {} } as unknown as ReadModel;
  const rootPaths: (string | undefined)[] = [];
  const provisioned: [string, string][] = [];
  const sup = new RunSupervisor({
    ptys,
    ports: {
      list: async (pids, options) => {
        state.listCalls.push({ pids, fresh: options?.fresh });
        return state.owned;
      },
      listeners: async () => state.listeners,
    },
    profilesFor: async (_projectId, rootPath) => {
      rootPaths.push(rootPath);
      return atRoot(repos, rootPath);
    },
    ...(opts.exists !== undefined ? { exists: opts.exists } : {}),
    provision:
      opts.provision ??
      (async (sourceRoot, worktreePath) => {
        provisioned.push([sourceRoot, worktreePath]);
      }),
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
  return { c, fake, ptys, sup, state, chunks, killed, alivePids, model, settle, rootPaths, provisioned };
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
    expect(stateOf(t.sup, "backend.redis")).toMatchObject({ state: "failed", reason: "exited with code 1", exit: { code: 1 } });
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

  it("fails a service that dies with a non-zero code however long it ran, naming the error line", async () => {
    const t = setup([repo("frontend", [svc("gui", { kind: "tauri", readiness: { kind: "port" }, listens: [{ name: "http", port: 1420, how: "fixed" }] })])]);
    await t.sup.start("p1");
    await t.settle();
    t.state.owned = [{ port: 1420, pid: 5, command: "node", url: "http://127.0.0.1:1420" }];
    await t.c.advance(1000);
    expect(stateOf(t.sup, "frontend.gui")?.state).toBe("ready");
    t.fake.handles[0]?.data("   Compiling tidereel v0.1.0\r\n\x1b[31merror\x1b[0m: failed to run custom build command for `tidereel`\r\n");
    t.fake.handles[0]?.data("  resource path `binaries/ffmpeg-aarch64-apple-darwin` doesn't exist\r\n");
    await t.c.advance(60_000);
    t.fake.handles[0]?.exit(101);
    expect(stateOf(t.sup, "frontend.gui")).toMatchObject({
      state: "failed",
      reason: "exited with code 101 — resource path `binaries/ffmpeg-aarch64-apple-darwin` doesn't exist",
      exit: { code: 101 },
    });
  });

  it("replaces a readiness timeout with the exit that followed it", async () => {
    const t = setup([repo("backend", [svc("api", { readiness: { kind: "log", pattern: "never" } })])]);
    await t.sup.start("p1");
    await t.settle();
    await t.c.advance(60_000);
    expect(stateOf(t.sup, "backend.api")?.reason).toBe("timeout");
    t.fake.handles[0]?.data("Error: Cannot find module 'express'\n");
    t.fake.handles[0]?.exit(1);
    expect(stateOf(t.sup, "backend.api")).toMatchObject({ state: "failed", reason: "exited with code 1 — Error: Cannot find module 'express'" });
  });

  it("calls a stopped service exited, not failed", async () => {
    const t = setup([repo("backend", [svc("api")])]);
    await t.sup.start("p1");
    await t.settle();
    await t.c.advance(6000);
    t.fake.handles[0]?.diesOn.add("SIGINT");
    t.fake.handles[0]?.data("error: something noisy\n");
    await t.sup.stop("p1", "backend.api");
    expect(stateOf(t.sup, "backend.api")).toMatchObject({ state: "exited", exit: { signal: "SIGINT" } });
    expect(stateOf(t.sup, "backend.api")?.reason).toBeUndefined();
  });

  it("fails fast with port-taken on the bind error and stops the terminal", async () => {
    const t = setup([repo("frontend", [svc("web", { readiness: { kind: "port" }, listens: [{ name: "http", port: 8081, how: "flag", flag: "--port" }] })])]);
    await t.sup.start("p1");
    await t.settle();
    t.fake.handles[0]?.data("error: Port 8081 is in use\r\n");
    expect(stateOf(t.sup, "frontend.web")).toMatchObject({ state: "failed", reason: "port-taken" });
    await t.c.advance(0);
    expect(t.fake.handles[0]?.signals).toEqual(["SIGINT"]);
    // the non-zero exit of that stop keeps the specific reason
    await t.c.advance(6000);
    expect(stateOf(t.sup, "frontend.web")).toMatchObject({ state: "failed", reason: "port-taken", exit: { signal: "SIGKILL" } });
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

  describe("from a thread's worktree", () => {
    const threads = {
      t1: { projectId: "p1", worktreePath: "/wt/feat", branch: "tide/feat" },
      t2: { projectId: "p1" },
      other: { projectId: "p2", worktreePath: "/wt/other" },
    };

    it("plans the root repo under the worktree; linked repos keep their paths", async () => {
      const t = setup([repo("backend", [svc("api", { cwd: "server" })]), repo("frontend", [svc("web")])], { threads });
      const plan = await t.sup.plan("p1", { threadId: "t1" });
      expect(t.rootPaths.at(-1)).toBe("/wt/feat");
      expect(plan).toMatchObject({ status: "ok", rootPath: "/wt/feat", rootBranch: "tide/feat" });
      expect(plan.rows.map((r) => r.cwd)).toEqual(["/wt/feat/server", "/src/frontend"]);
      // a thread without a worktree runs the main checkout
      const main = await t.sup.plan("p1", { threadId: "t2" });
      expect(t.rootPaths.at(-1)).toBeUndefined();
      expect(main.rootPath).toBeUndefined();
      expect(main.rows[0]?.cwd).toBe("/src/backend/server");
    });

    it("refuses a thread of another project or an unknown thread", async () => {
      const t = setup([repo("backend", [svc("api")])], { threads });
      await expect(t.sup.plan("p1", { threadId: "other" })).rejects.toMatchObject({ code: "invalid-params" });
      await expect(t.sup.start("p1", { threadId: "nope" })).rejects.toMatchObject({ code: "invalid-params" });
    });

    it("records the worktree on the session and restarts from it", async () => {
      const t = setup([repo("backend", [svc("api")])], { threads });
      const session = await t.sup.start("p1", { threadId: "t1" });
      await t.settle();
      expect(session.worktree).toEqual({ threadId: "t1", path: "/wt/feat", branch: "tide/feat" });
      expect(t.fake.handles[0]?.spec.cwd).toBe("/wt/feat");
      t.fake.handles[0]?.diesOn.add("SIGINT");
      await t.sup.restart("p1", "backend.api");
      await t.settle();
      expect(t.fake.handles[1]?.spec.cwd).toBe("/wt/feat");
    });

    it("blocks a plan from another checkout while a stack runs, and start refuses unless forced", async () => {
      const t = setup([repo("backend", [svc("api")])], { threads });
      await t.sup.start("p1");
      await t.settle();
      const plan = await t.sup.plan("p1", { threadId: "t1" });
      expect(plan.status).toBe("blocked");
      expect(plan.conflicts).toContainEqual({ key: "backend.*", port: 0, with: "main checkout", reason: "stack already running from main checkout; stop it first" });
      await expect(t.sup.start("p1", { threadId: "t1" })).rejects.toMatchObject({ code: "conflict" });
      // the same checkout is no conflict
      expect((await t.sup.plan("p1", { threadId: "t2" })).status).toBe("ok");
    });

    it("names the worktree's branch when the running stack is the worktree's", async () => {
      const t = setup([repo("backend", [svc("api")])], { threads });
      await t.sup.start("p1", { threadId: "t1" });
      await t.settle();
      const plan = await t.sup.plan("p1");
      expect(plan.conflicts[0]?.reason).toBe("stack already running from tide/feat; stop it first");
    });

    it("says dependencies are missing when a root service dies at once in a worktree without node_modules", async () => {
      const probed: string[] = [];
      const exists = async (path: string): Promise<boolean> => {
        probed.push(path);
        return false;
      };
      const t = setup([repo("backend", [svc("web", { kind: "vite", cwd: "web" }), svc("api", { kind: "uvicorn" })]), repo("frontend", [svc("app", { kind: "vite" })])], { threads, exists });
      await t.sup.start("p1", { threadId: "t1" });
      await t.settle();
      t.fake.handles[0]?.exit(127);
      t.fake.handles[1]?.exit(1);
      t.fake.handles[2]?.exit(1);
      await t.settle();
      expect(stateOf(t.sup, "backend.web")).toMatchObject({ state: "failed", reason: "dependencies missing in this worktree — run the install step (e.g. npm install) there first" });
      expect(stateOf(t.sup, "backend.api")?.reason).toContain("dependencies missing");
      expect(probed).toEqual(expect.arrayContaining(["/wt/feat/web/node_modules", "/wt/feat/node_modules", "/wt/feat/venv", "/wt/feat/.venv"]));
      // linked repos never get the hint
      expect(stateOf(t.sup, "frontend.app")).toMatchObject({ state: "failed", reason: "exited with code 1" });
    });

    it("keeps the generic reason when the worktree has its dependencies", async () => {
      const t = setup([repo("backend", [svc("web", { kind: "vite", cwd: "web" })])], { threads, exists: async (p) => p === "/wt/feat/node_modules" });
      await t.sup.start("p1", { threadId: "t1" });
      await t.settle();
      t.fake.handles[0]?.exit(1);
      await t.settle();
      expect(stateOf(t.sup, "backend.web")).toMatchObject({ state: "failed", reason: "exited with code 1" });
    });

    it("copies .worktreeinclude files into the worktree on start, and a provisioning failure does not block it", async () => {
      const t = setup([repo("backend", [svc("api")])], { threads });
      await t.sup.start("p1", { threadId: "t1" });
      expect(t.provisioned).toEqual([["/src/backend", "/wt/feat"]]);
      await t.sup.stop("p1");
      await t.sup.start("p1");
      expect(t.provisioned).toHaveLength(1);

      const broken = setup([repo("backend", [svc("api")])], { threads, provision: async () => Promise.reject(new Error("disk full")) });
      const session = await broken.sup.start("p1", { threadId: "t1" });
      expect(Object.keys(session.services)).toEqual(["backend.api"]);
    });
  });
});
