import { describe, expect, it } from "vitest";
import type { Activity, ModelChunk, RpcFrame } from "@tide/contracts";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { DriverRegistry } from "../provider/registry.ts";
import { registerHandlers } from "./handlers.ts";
import { RpcRouter } from "./router.ts";

const tool = (id: string, threadId: string, turnId: string): Activity =>
  ({ id, threadId, turnId, kind: "tool", toolUseId: id, toolName: "Read", input: {}, status: "ok", createdAt: 1, updatedAt: 1 }) as Activity;

async function setup() {
  const store = new EventStore(await openDatabase(":memory:"));
  const engine = new Engine({ store });
  const project = (await engine.dispatch({ type: "project.create", title: "P", rootPath: "/repo" })).events[0]?.event;
  if (project?.type !== "project.created") throw new Error("expected project");
  const created = (await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude" })).events[0]?.event;
  if (created?.type !== "thread.created") throw new Error("expected thread");
  const threadId = created.thread.id;
  const turnIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    await engine.dispatch({ type: "turn.request", threadId, text: `go ${i}` });
    const turn = Object.values(engine.getModel().turns).find((t) => t.threadId === threadId && !turnIds.includes(t.id))!;
    turnIds.push(turn.id);
    await engine.dispatch({ type: "turn.start", turnId: turn.id, provider: "claude" });
    await engine.dispatch({ type: "activity.upsert", activity: tool(`a${i}`, threadId, turn.id) });
    if (i === 0) await engine.dispatch({ type: "turn.settle", turnId: turn.id, status: "completed" });
  }
  const router = new RpcRouter();
  registerHandlers(router, {
    engine,
    store,
    registry: new DriverRegistry({ env: { dataDir: ":memory:", log: () => undefined } }),
    environmentId: "env",
    version: "test",
    startedAt: 0,
  });
  const frames: RpcFrame[] = [];
  const connection = router.connection("c1", (f) => frames.push(f));
  return { engine, threadId, turnIds, frames, connection };
}

describe("R24 activity residency over RPC", () => {
  it("a resident subscription's snapshot holds only the in-flight turn's activities", async () => {
    const { frames, connection } = await setup();
    await connection.handleRequest("s1", "model.subscribe", { scope: "resident" });
    const chunk = frames.flatMap((f) => ("chunk" in f ? [f.chunk as ModelChunk] : []))[0];
    if (chunk?.kind !== "snapshot") throw new Error("expected a snapshot");
    expect(Object.keys(chunk.model.activities)).toEqual(["a1"]);
  });

  it("thread.activities returns the requested turns' activities at the current seq", async () => {
    const { engine, threadId, turnIds, frames, connection } = await setup();
    await connection.handleRequest("r1", "thread.activities", { threadId, turnIds: [turnIds[0]!] });
    const frame = frames.find((f) => f.id === "r1");
    if (!frame || !("result" in frame)) throw new Error(`no result: ${JSON.stringify(frame)}`);
    const result = frame.result as { seq: number; activities: Activity[] };
    expect(result.seq).toBe(engine.getModel().seq);
    expect(result.activities.map((a) => a.id)).toEqual(["a0"]);

    await connection.handleRequest("r2", "thread.activities", { threadId: "missing", turnIds: [] });
    expect(JSON.stringify(frames.find((f) => f.id === "r2"))).toContain("not-found");
  });
});
