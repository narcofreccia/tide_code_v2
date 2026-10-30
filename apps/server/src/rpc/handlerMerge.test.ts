import { afterEach, describe, expect, it } from "vitest";
import type { RpcFrame } from "@tide/contracts";
import { Engine } from "../orchestration/engine.ts";
import { openEventStore } from "../orchestration/store.ts";
import { DriverRegistry } from "../provider/registry.ts";
import { SettingsStore } from "../settings.ts";
import { registerHandlers } from "./handlers.ts";
import { RpcRouter } from "./router.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup() {
  const store = await openEventStore(":memory:");
  cleanups.push(async () => store.close());
  const engine = new Engine({ store });
  const settings = new SettingsStore();
  const router = new RpcRouter();
  registerHandlers(router, { engine, store, settings, registry: new DriverRegistry({ env: { dataDir: ":memory:", log: () => undefined } }), environmentId: "env", version: "test", startedAt: 0 });
  const frames: RpcFrame[] = [];
  const connection = router.connection("c1", (f) => frames.push(f));
  let seq = 0;
  const call = async (method: string, params: unknown): Promise<unknown> => {
    const id = `r${++seq}`;
    await connection.handleRequest(id, method, params);
    const frame = frames.find((f) => f.id === id);
    if (frame && "error" in frame) throw new Error(frame.error.message);
    return frame && "result" in frame ? frame.result : undefined;
  };
  const project = (await engine.dispatch({ type: "project.create", title: "R", rootPath: "/repos/r" })).events[0]?.event;
  if (project?.type !== "project.created") throw new Error("project");
  const mkThread = async (): Promise<string> => {
    const e = (await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude" })).events[0]?.event;
    if (e?.type !== "thread.created") throw new Error("thread");
    await engine.dispatch({ type: "worktree.attach", threadId: e.thread.id, worktreePath: `/wt/${e.thread.id}`, branch: `tide/${e.thread.id}` });
    return e.thread.id;
  };
  const events: { type: string; strategy?: string; deleteBranch?: boolean }[] = [];
  engine.subscribe((record) => events.push(record.event as { type: string }));
  const requested = () => events.find((e) => e.type === "merge.requested");
  return { call, settings, mkThread, requested };
}

describe("thread.merge defaults from settings.git", () => {
  it("fills strategy and deleteBranch when the command omits them", async () => {
    const s = await setup();
    await s.call("settings.set", { patch: { git: { mergeStrategy: "rebase", deleteBranchOnMerge: false } } });
    const t = await s.mkThread();
    await s.call("orchestration.dispatch", { command: { type: "thread.merge", threadId: t } });
    expect(s.requested()).toMatchObject({ strategy: "rebase", deleteBranch: false });
  });

  it("an explicit strategy wins", async () => {
    const s = await setup();
    await s.call("settings.set", { patch: { git: { mergeStrategy: "rebase" } } });
    const t = await s.mkThread();
    await s.call("orchestration.dispatch", { command: { type: "thread.merge", threadId: t, strategy: "merge" } });
    expect(s.requested()).toMatchObject({ strategy: "merge", deleteBranch: true });
  });
});
