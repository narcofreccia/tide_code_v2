import { afterEach, describe, expect, it } from "vitest";
import type { DomainEvent } from "@tide/contracts";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { ProviderReactor } from "./reactor.ts";
import { DriverRegistry } from "./registry.ts";
import { SessionDirectory } from "./sessions.ts";
import { awaitUserInput, createFakeDriver, emit } from "./testing/fakeDriver.ts";

// R16: a secret card is Tide's own; its answer never reaches the harness.

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function waitFor(engine: Engine, match: (event: DomainEvent) => boolean): Promise<DomainEvent> {
  return new Promise((resolve) => {
    const off = engine.subscribe((record) => {
      if (!match(record.event)) return;
      off();
      resolve(record.event);
    });
  });
}

describe("ProviderReactor: secret cards", () => {
  it("does not forward a secret answer to the driver, but still forwards a harness question", async () => {
    const store = new EventStore(await openDatabase(":memory:"));
    const engine = new Engine({ store });
    const { driver, control } = createFakeDriver("claude");
    const registry = new DriverRegistry({ env: { dataDir: ":memory:", log: () => undefined } });
    registry.register(driver);
    const sessions = new SessionDirectory({ registry, autoReap: false, log: () => undefined, model: () => engine.getModel() });
    const reactor = new ProviderReactor({ engine, sessions, log: () => undefined });
    reactor.start();
    closers.push(() => {
      reactor.stop();
      store.close();
    });
    const project = (await engine.dispatch({ type: "project.create", title: "T", rootPath: "/repo" })).events[0]?.event;
    if (project?.type !== "project.created") throw new Error("expected project");
    const created = (await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude" })).events[0]?.event;
    if (created?.type !== "thread.created") throw new Error("expected thread");
    const threadId = created.thread.id;

    control.script(
      emit({ type: "activity", activity: { kind: "user-input", requestId: "q1", questions: [{ id: "a", text: "Which?" }], status: "pending" } }),
      awaitUserInput("q1"),
      emit({ type: "settled", status: "completed" }),
    );
    const asked = waitFor(engine, (e) => e.type === "activity.upserted" && e.activity.kind === "user-input");
    const requested = (await engine.dispatch({ type: "turn.request", threadId, text: "go" })).events.find((r) => r.event.type === "turn.requested")?.event;
    if (requested?.type !== "turn.requested") throw new Error("expected turn");
    await asked;

    const now = Date.now();
    await engine.dispatch({
      type: "activity.upsert",
      activity: { id: "act-secret", threadId, turnId: requested.turn.id, kind: "user-input", secret: true, requestId: "secret:1", questions: [{ id: "API_KEY", text: "call the API" }], status: "pending", createdAt: now, updatedAt: now },
    });
    await engine.dispatch({ type: "user-input.respond", threadId, requestId: "secret:1", answers: { decided: "provided" } });
    await engine.dispatch({ type: "user-input.respond", threadId, requestId: "q1", answers: { a: "A" } });
    await reactor.drain();
    expect(control.userInputs).toEqual([{ requestId: "q1", answers: { a: "A" } }]);
    expect(engine.getModel().turns[requested.turn.id]?.status).toBe("completed");
  });
});
