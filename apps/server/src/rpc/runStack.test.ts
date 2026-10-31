import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RpcFrame, RunRepo } from "@tide/contracts";
import { Engine } from "../orchestration/engine.ts";
import { openEventStore } from "../orchestration/store.ts";
import { PortLister } from "../workspace/ports.ts";
import { fakeBackend } from "../workspace/pty/fakeBackend.ts";
import { PtyManager } from "../workspace/pty/index.ts";
import { RpcRouter } from "./router.ts";
import { registerRunStackHandlers } from "./runStack.ts";
import { createWorkspaceServices, registerWorkspaceHandlers } from "./workspace.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(repos: (root: string) => RunRepo[] = () => []) {
  const dir = await mkdtemp(join(tmpdir(), "tide-run-rpc-"));
  const root = join(dir, "app");
  await mkdir(join(root, "web"), { recursive: true });
  await mkdir(join(dir, "outside"));
  await symlink(join(dir, "outside"), join(root, "escape"));
  const store = await openEventStore(":memory:");
  cleanups.push(() => rm(dir, { recursive: true, force: true }), () => store.close());
  const engine = new Engine({ store });
  const fake = fakeBackend();
  const ports = new PortLister({ probe: { listeners: async () => undefined, processes: async () => undefined } });
  const workspace = createWorkspaceServices({ engine, ptys: new PtyManager({ backend: fake.backend }), ports });
  cleanups.push(() => workspace.close());
  const router = new RpcRouter();
  registerWorkspaceHandlers(router, workspace);
  const supervisor = registerRunStackHandlers(router, { engine, workspace, profilesFor: async () => repos(root) });
  cleanups.push(() => supervisor.close());
  const created = (await engine.dispatch({ type: "project.create", title: "App", rootPath: root })).events[0]?.event;
  if (created?.type !== "project.created") throw new Error("expected project.created");
  const projectId = created.project.id;

  const frames: RpcFrame[] = [];
  const connection = router.connection("c1", (frame) => frames.push(frame));
  cleanups.push(() => connection.close());
  let seq = 0;
  const call = async <T,>(method: string, params: unknown): Promise<{ result?: T; error?: { code: string; message: string } }> => {
    const id = `r${++seq}`;
    await connection.handleRequest(id, method, params);
    const frame = frames.find((f) => f.id === id);
    if (frame && "result" in frame) return { result: frame.result as T };
    if (frame && "error" in frame) return { error: frame.error };
    throw new Error(`no frame for ${method}`);
  };
  return { root, dir, projectId, fake, call, frames, connection, supervisor };
}

describe("rpc: run terminals and the run stack", () => {
  it("creates a run terminal inside the project with env and command, and lists it by owner", async () => {
    const { root, projectId, fake, call } = await setup();
    const ownerId = `run:${projectId}`;
    const created = await call<{ ptyId: string }>("pty.create", { ownerId, cwd: join(root, "web"), cols: 120, rows: 30, env: { PORT: "8082" }, command: "pnpm dev" });
    expect(created.result?.ptyId).toBeTruthy();
    expect(fake.handles[0]?.spec.env["PORT"]).toBe("8082");
    expect(fake.handles[0]?.spec.cwd.endsWith(join("app", "web"))).toBe(true);
    const listed = await call<{ ptys: { ptyId: string }[] }>("pty.list", { ownerId });
    expect(listed.result?.ptys.map((p) => p.ptyId)).toEqual([created.result?.ptyId]);
    expect((await call("pty.list", {})).error?.code).toBe("invalid-params");
  });

  it("refuses a run terminal outside the project, through a symlink, or without a cwd", async () => {
    const { root, dir, projectId, call } = await setup();
    const ownerId = `run:${projectId}`;
    expect((await call("pty.create", { ownerId, cwd: join(dir, "outside"), cols: 80, rows: 24 })).error?.code).toBe("forbidden");
    expect((await call("pty.create", { ownerId, cwd: join(root, "escape"), cols: 80, rows: 24 })).error?.code).toBe("forbidden");
    expect((await call("pty.create", { ownerId, cols: 80, rows: 24 })).error?.code).toBe("invalid-params");
    expect((await call("pty.create", { ownerId: "run:nope", cwd: root, cols: 80, rows: 24 })).error?.code).toBe("not-found");
    expect((await call("pty.create", { ownerId: "someone", cwd: root, cols: 80, rows: 24 })).error?.code).toBe("invalid-params");
  });

  it("plans, starts, streams and stops a stack", async () => {
    const repos = (root: string): RunRepo[] => [
      {
        repoId: "root",
        repoKey: "app",
        path: root,
        label: "app",
        stale: false,
        profile: {
          version: 1,
          repoKey: "app",
          source: "user",
          manifestHash: "",
          generatedAt: 0,
          warnings: [],
          services: [{ id: "web", name: "web", cwd: "web", command: "pnpm dev", listens: [{ name: "http", port: 5173, how: "env", envVar: "PORT" }], connects: [], env: {}, readiness: { kind: "log", pattern: "ready" } }],
        },
      },
    ];
    const { projectId, fake, call, frames, connection, supervisor } = await setup(repos);
    const plan = await call<{ status: string; rows: { key: string; env: Record<string, string> }[] }>("run.plan", { projectId });
    expect(plan.result).toMatchObject({ status: "ok", rows: [{ key: "app.web", env: { PORT: "5173" } }] });
    expect((await call("run.plan", { projectId: "nope" })).error?.code).toBe("not-found");

    await connection.handleRequest("sub", "run.subscribe", { projectId });
    const started = await call<{ services: Record<string, { state: string }> }>("run.start", { projectId });
    expect(started.result?.services["app.web"]?.state).toBe("starting");
    await supervisor.drain();
    fake.handles[0]?.data("ready\r\n");
    fake.handles[0]?.diesOn.add("SIGINT");
    expect((await call("run.stop", { projectId })).result).toEqual({ ok: true });
    const chunks = frames.filter((f) => f.id === "sub" && "chunk" in f).map((f) => (f as { chunk: { kind: string; status?: { state: string } } }).chunk);
    expect(chunks[0]?.kind).toBe("snapshot");
    expect(chunks.filter((c) => c.kind === "service").map((c) => c.status?.state)).toEqual(expect.arrayContaining(["starting", "ready", "exited"]));
    expect(chunks.at(-1)).toEqual({ kind: "ended" });
    expect(connection.cancelStream("sub")).toBe(true);
  });
});
