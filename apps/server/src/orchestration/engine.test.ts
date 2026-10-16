import { describe, it, expect } from "vitest";
import type { EventRecord } from "@tide/contracts";
import { openDatabase } from "../db/sqlite.ts";
import { CommandError, Engine } from "./engine.ts";
import { EventStore } from "./store.ts";

async function memoryStore(): Promise<EventStore> {
  return new EventStore(await openDatabase(":memory:"));
}

describe("Engine", () => {
  it("dispatches commands and projects the read model", async () => {
    const store = await memoryStore();
    const engine = new Engine({ store });

    const created = await engine.dispatch({ type: "project.create", title: "Tide", rootPath: "/repo" });
    const projectEvent = created.events[0];
    if (projectEvent?.event.type !== "project.created") throw new Error("expected project.created");
    const projectId = projectEvent.event.project.id;

    const thread = await engine.dispatch({ type: "thread.create", projectId, provider: "claude" });
    const threadEvent = thread.events[0];
    if (threadEvent?.event.type !== "thread.created") throw new Error("expected thread.created");

    const model = engine.getModel();
    expect(model.seq).toBe(2);
    expect(model.projects[projectId]).toMatchObject({ title: "Tide", rootPath: "/repo" });
    expect(model.threads[threadEvent.event.thread.id]).toMatchObject({ projectId, status: "idle" });

    // durability: a fresh engine over the same log rehydrates the same model
    const rehydrated = new Engine({ store });
    expect(rehydrated.getModel()).toEqual(model);
  });

  it("rejects invalid commands before touching the store", async () => {
    const store = await memoryStore();
    const engine = new Engine({ store });
    await expect(
      engine.dispatch({ type: "project.create", title: "", rootPath: "/repo" }),
    ).rejects.toMatchObject({ code: "invalid-command" });
    await expect(engine.dispatch({ type: "thread.obliterate", threadId: "x" } as never)).rejects.toMatchObject({
      code: "invalid-command",
      message: expect.stringContaining('unknown command type "thread.obliterate"'),
    });
    expect(store.lastSeq()).toBe(0);
  });

  it("surfaces decider rejections as CommandError", async () => {
    const store = await memoryStore();
    const engine = new Engine({ store });
    await engine.dispatch({ type: "project.create", title: "A", rootPath: "/repo" });
    const err = await engine.dispatch({ type: "project.create", title: "B", rootPath: "/repo" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect((err as CommandError).code).toBe("conflict");
  });

  it("serialises concurrent dispatches with strictly increasing seqs", async () => {
    const store = await memoryStore();
    const engine = new Engine({ store });
    const seen: EventRecord[] = [];
    engine.subscribe((rec) => seen.push(rec));

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        engine.dispatch({ type: "project.create", title: `p${i}`, rootPath: `/repo/${i}` }),
      ),
    );
    await engine.drain();

    const seqs = results.map((r) => r.seq);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(seen.map((r) => r.seq)).toEqual(seqs);
    expect(Object.keys(engine.getModel().projects)).toHaveLength(50);
    expect(engine.getModel().seq).toBe(50);
    expect(store.lastSeq()).toBe(50);
  });

  it("unsubscribes listeners", async () => {
    const store = await memoryStore();
    const engine = new Engine({ store });
    let count = 0;
    const off = engine.subscribe(() => count++);
    await engine.dispatch({ type: "project.create", title: "A", rootPath: "/a" });
    off();
    await engine.dispatch({ type: "project.create", title: "B", rootPath: "/b" });
    expect(count).toBe(1);
  });

  it("stores meta values", async () => {
    const store = await memoryStore();
    expect(store.getMeta("environmentId")).toBeUndefined();
    store.setMeta("environmentId", "env-1");
    expect(store.getMeta("environmentId")).toBe("env-1");
    store.setMeta("environmentId", "env-2");
    expect(store.getMeta("environmentId")).toBe("env-2");
  });

  describe("command receipts", () => {
    it("replays the identical result for a repeated commandId without new events", async () => {
      const store = await memoryStore();
      const engine = new Engine({ store });
      const cmd = { type: "project.create", commandId: "c1", title: "A", rootPath: "/a" } as const;
      const first = await engine.dispatch(cmd);
      const second = await engine.dispatch(cmd);
      expect(second).toEqual(first);
      expect(store.lastSeq()).toBe(1);
      expect(Object.keys(engine.getModel().projects)).toHaveLength(1);
    });

    it("treats different commandIds as different commands", async () => {
      const store = await memoryStore();
      const engine = new Engine({ store });
      const a = await engine.dispatch({ type: "project.create", commandId: "c1", title: "A", rootPath: "/a" });
      const b = await engine.dispatch({ type: "project.create", commandId: "c2", title: "B", rootPath: "/b" });
      expect(a.seq).toBe(1);
      expect(b.seq).toBe(2);
      expect(store.lastSeq()).toBe(2);
    });

    it("does not record rejections, so a retry re-evaluates", async () => {
      const store = await memoryStore();
      const engine = new Engine({ store });
      const first = await engine.dispatch({ type: "project.create", title: "A", rootPath: "/a" });
      const ev = first.events[0]?.event;
      if (ev?.type !== "project.created") throw new Error("expected project.created");
      const retry = { type: "project.create", commandId: "r1", title: "B", rootPath: "/a" } as const;
      await expect(engine.dispatch(retry)).rejects.toMatchObject({ code: "conflict" });
      expect(store.getReceipt("r1")).toBeUndefined();
      await engine.dispatch({ type: "project.archive", projectId: ev.project.id });
      const ok = await engine.dispatch(retry);
      expect(ok.events[0]?.event.type).toBe("project.created");
      expect(store.getReceipt("r1")).toMatchObject({ firstSeq: ok.seq, lastSeq: ok.seq });
    });

    it("records a receipt for zero-event commands and replays them as empty", async () => {
      const store = await memoryStore();
      const engine = new Engine({ store });
      const p = await engine.dispatch({ type: "project.create", title: "A", rootPath: "/a" });
      const pe = p.events[0]?.event;
      if (pe?.type !== "project.created") throw new Error("expected project.created");
      const t = await engine.dispatch({ type: "thread.create", projectId: pe.project.id, provider: "claude" });
      const te = t.events[0]?.event;
      if (te?.type !== "thread.created") throw new Error("expected thread.created");
      const threadId = te.thread.id;
      await engine.dispatch({ type: "thread.archive", threadId });
      const seq = store.lastSeq();
      const cmd = { type: "thread.archive", commandId: "z1", threadId } as const;
      const first = await engine.dispatch(cmd);
      expect(first.events).toEqual([]);
      expect(store.getReceipt("z1")).toMatchObject({ firstSeq: 0, lastSeq: 0 });
      const again = await engine.dispatch(cmd);
      expect(again).toEqual({ seq: engine.getModel().seq, events: [] });
      expect(store.lastSeq()).toBe(seq);
    });
  });
});
