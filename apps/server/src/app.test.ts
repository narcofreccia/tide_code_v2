import { describe, expect, it } from "vitest";
import type { Activity } from "@tide/contracts";
import { createApp } from "./app.ts";
import type { ServerConfig } from "./config.ts";
import { Engine } from "./orchestration/engine.ts";
import { openEventStore, type EventStore } from "./orchestration/store.ts";
import { awaitApproval, createFakeDriver, emit } from "./provider/testing/fakeDriver.ts";

const config: ServerConfig = {
  tideHome: "/tmp/tide-app-test",
  dataDir: ":memory:",
  dbPath: ":memory:",
  environmentId: "env-app",
  token: "t",
  host: "127.0.0.1",
  port: 0,
  dev: true,
  printToken: false,
  corsOrigins: [],
  version: "0.0.0-test",
  providers: {},
};

describe("createApp", () => {
  it("wires engine, registry, sessions and reactor so a turn runs end to end", async () => {
    const { driver, control } = createFakeDriver("claude");
    const app = await createApp({
      config,
      listen: false,
      log: () => undefined,
      registerDrivers: (registry) => registry.register(driver),
    });
    try {
      expect(app.registry.list()).toEqual(["claude"]);
      expect(app.server).toBeUndefined();

      const project = (await app.engine.dispatch({ type: "project.create", title: "T", rootPath: "/repo" })).events[0]?.event;
      if (project?.type !== "project.created") throw new Error("expected project.created");
      const thread = (await app.engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude" })).events[0]?.event;
      if (thread?.type !== "thread.created") throw new Error("expected thread.created");

      control.script(emit({ type: "assistant.delta", messageKey: "m", delta: "pong" }), emit({ type: "settled", status: "completed" }));
      await app.engine.dispatch({ type: "turn.request", threadId: thread.thread.id, text: "ping" });
      await app.reactor.drain();

      const model = app.engine.getModel();
      const texts = (model.threadMessages[thread.thread.id] ?? []).map((id) => model.messages[id]?.text);
      expect(texts).toEqual(["ping", "pong"]);
      expect(model.threads[thread.thread.id]?.status).toBe("idle");
    } finally {
      await app.close();
    }
  });
});

/**
 * The log a crashed process leaves behind: a turn still `running` with an approval nobody can
 * answer any more. Built through the ordinary command path, then handed to a fresh app.
 */
async function storeWithLiveTurn(): Promise<{ store: EventStore; threadId: string; turnId: string }> {
  const store = await openEventStore(":memory:");
  const engine = new Engine({ store });
  const project = (await engine.dispatch({ type: "project.create", title: "T", rootPath: "/repo" })).events[0]?.event;
  if (project?.type !== "project.created") throw new Error("expected project.created");
  const thread = (await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude" })).events[0]?.event;
  if (thread?.type !== "thread.created") throw new Error("expected thread.created");
  const turn = (await engine.dispatch({ type: "turn.request", threadId: thread.thread.id, text: "go" })).events[0]?.event;
  if (turn?.type !== "turn.requested") throw new Error("expected turn.requested");
  await engine.dispatch({ type: "turn.start", turnId: turn.turn.id, provider: "claude" });
  const activity: Activity = {
    id: "a1",
    threadId: thread.thread.id,
    turnId: turn.turn.id,
    kind: "approval",
    requestId: "r1",
    toolName: "Bash",
    input: { command: "ls" },
    status: "pending",
    createdAt: 1,
    updatedAt: 1,
  };
  await engine.dispatch({ type: "activity.upsert", activity });
  return { store, threadId: thread.thread.id, turnId: turn.turn.id };
}

describe("createApp — restart recovery", () => {
  it("settles turns a previous run left running and cancels their pending prompts", async () => {
    const { store, threadId, turnId } = await storeWithLiveTurn();
    expect(store.readAll().length).toBeGreaterThan(0);

    const { driver } = createFakeDriver("claude");
    const app = await createApp({ config, store, listen: false, log: () => undefined, registerDrivers: (r) => r.register(driver) });
    const model = app.engine.getModel();
    try {
      expect(model.turns[turnId]).toMatchObject({ status: "error", error: "server restarted while this turn was running" });
      expect(model.threads[threadId]?.status).toBe("error");
      expect(model.threads[threadId]?.attention).toBeUndefined();
      expect(model.activities["a1"]).toMatchObject({ kind: "approval", status: "resolved", decision: "cancel" });
      // and the thread is usable again
      expect(app.engine.getModel().threads[threadId]?.status).not.toBe("running");
    } finally {
      await app.close();
    }
  });
});

describe("app.close — graceful shutdown", () => {
  it("interrupts and settles an in-flight turn before the store closes", async () => {
    const { driver, control } = createFakeDriver("claude");
    // the stuck driver below never drains, so the bounded fallback is what ends close() —
    // zero keeps that deterministic instead of waiting out the production window
    const app = await createApp({
      config,
      listen: false,
      log: () => undefined,
      shutdownTimeoutMs: 0,
      registerDrivers: (r) => r.register(driver),
    });
    const project = (await app.engine.dispatch({ type: "project.create", title: "T", rootPath: "/repo" })).events[0]?.event;
    if (project?.type !== "project.created") throw new Error("expected project.created");
    const thread = (await app.engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude" })).events[0]?.event;
    if (thread?.type !== "thread.created") throw new Error("expected thread.created");

    // the driver hangs on an approval nobody answers: the turn is still live at shutdown
    control.script(
      emit({ type: "activity", activity: { kind: "approval", requestId: "r1", toolName: "Bash", input: {}, status: "pending" } }),
      awaitApproval("r1"),
    );
    const started = new Promise<void>((resolve) => {
      const off = app.engine.subscribe((record) => {
        if (record.event.type !== "turn.started") return;
        off();
        resolve();
      });
    });
    const turn = (await app.engine.dispatch({ type: "turn.request", threadId: thread.thread.id, text: "go" })).events[0]?.event;
    if (turn?.type !== "turn.requested") throw new Error("expected turn.requested");
    await started;

    await app.close();

    const model = app.engine.getModel();
    expect(model.turns[turn.turn.id]).toMatchObject({ status: "interrupted", error: "server shutting down" });
    expect(model.threads[thread.thread.id]?.status).toBe("interrupted");
    expect(control.interrupts).toContain(thread.thread.id);
  });
});
