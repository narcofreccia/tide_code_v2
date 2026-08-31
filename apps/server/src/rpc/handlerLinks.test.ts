import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RpcFrame } from "@tide/contracts";
import { Engine } from "../orchestration/engine.ts";
import { openEventStore, type EventStore } from "../orchestration/store.ts";
import { DriverRegistry } from "../provider/registry.ts";
import { registerHandlers } from "./handlers.ts";
import { RpcRouter } from "./router.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(): Promise<{
  call<T>(method: string, params: unknown): Promise<{ result?: T; error?: { code: string; message: string } }>;
  engine: Engine;
  projectId: string;
}> {
  const store: EventStore = await openEventStore(":memory:");
  cleanups.push(async () => store.close());
  const engine = new Engine({ store });
  const router = new RpcRouter();
  registerHandlers(router, {
    engine,
    store,
    registry: new DriverRegistry({ env: { dataDir: ":memory:", log: () => undefined } }),
    environmentId: "env",
    version: "test",
    startedAt: 0,
  });
  const created = (await engine.dispatch({ type: "project.create", title: "API", rootPath: "/repos/api" })).events[0]?.event;
  if (created?.type !== "project.created") throw new Error("expected project.created");

  const frames: RpcFrame[] = [];
  const connection = router.connection("c1", (frame) => frames.push(frame));
  let seq = 0;
  const call = async <T,>(method: string, params: unknown): Promise<{ result?: T; error?: { code: string; message: string } }> => {
    const id = `r${++seq}`;
    await connection.handleRequest(id, method, params);
    const frame = frames.find((f) => f.id === id);
    if (frame && "result" in frame) return { result: frame.result as T };
    if (frame && "error" in frame) return { error: frame.error };
    throw new Error(`no frame for ${method}`);
  };
  return { call, engine, projectId: created.project.id };
}

const add = (projectId: string, path: string): unknown => ({ command: { type: "project.link.add", projectId, path, label: "frontend" } });

describe("project.link.add path guard", () => {
  it("rejects a path that does not exist", async () => {
    const s = await setup();
    const result = await s.call("orchestration.dispatch", add(s.projectId, join(tmpdir(), "tide-missing-link-dir")));
    expect(result.error?.code).toBe("not-found");
    expect(s.engine.getModel().projects[s.projectId]?.links ?? []).toEqual([]);
  });

  it("rejects a path that is a file rather than a directory", async () => {
    const s = await setup();
    const dir = await mkdtemp(join(tmpdir(), "tide-link-guard-"));
    const file = join(dir, "not-a-repo.txt");
    await writeFile(file, "x");
    expect((await s.call("orchestration.dispatch", add(s.projectId, file))).error?.code).toBe("invalid-params");
  });

  it("accepts a real directory and records its realpath, so symlinks compare equal", async () => {
    const s = await setup();
    // on macOS $TMPDIR is itself a symlink (/var → /private/var); the recorded path is resolved
    const dir = await mkdtemp(join(tmpdir(), "tide-link-guard-"));
    expect((await s.call("orchestration.dispatch", add(s.projectId, dir))).error).toBeUndefined();
    const link = s.engine.getModel().projects[s.projectId]?.links?.[0];
    expect(link?.label).toBe("frontend");
    expect(link?.path.startsWith("/")).toBe(true);
    // adding it again by its unresolved name is caught as a duplicate
    expect((await s.call("orchestration.dispatch", add(s.projectId, `${dir}/`))).error?.code).toBe("conflict");
  });
});
