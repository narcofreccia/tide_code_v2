import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../app.ts";
import { baseConfig } from "../vcs/testing/vcsHarness.ts";
import { createFakeDriver, effect, emit } from "../provider/testing/fakeDriver.ts";
import type { CancelTimer } from "./delegation.ts";

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

function manualTimers(): { count: () => number; schedule: (fn: () => void, ms: number) => CancelTimer; fire: () => void } {
  const timers: { fn: () => void; cancelled: boolean }[] = [];
  return {
    count: () => timers.filter((t) => !t.cancelled).length,
    schedule: (fn) => {
      const t = { fn, cancelled: false };
      timers.push(t);
      return () => void (t.cancelled = true);
    },
    fire: () => {
      for (const t of timers.splice(0)) if (!t.cancelled) t.fn();
    },
  };
}

/** A turn that says it started, then holds until the test opens `release`. */
function heldTurn(started: Gate, release: Gate, reply: string) {
  return [
    effect(async () => {
      started.open();
      await release.promise;
    }),
    emit({ type: "assistant.delta", messageKey: "m0", delta: reply }),
    emit({ type: "settled", status: "completed" }),
  ];
}

describe("delegation across two provider kinds", () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("a parent on one kind delegates to its own kind and another in parallel, and gets one batched wake-up after its turn ended", async () => {
    const clock = manualTimers();
    const claude = createFakeDriver("claude");
    const codex = createFakeDriver("codex");
    app = await createApp({
      config: baseConfig("/tmp/tide-delegation-kinds-test"),
      listen: false,
      log: () => undefined,
      delegationSchedule: clock.schedule,
      registerDrivers: (registry) => {
        registry.register(claude.driver);
        registry.register(codex.driver);
      },
    });
    const engine = app.engine;
    const project = (await engine.dispatch({ type: "project.create", title: "P", rootPath: "/tmp/tide-delegation-kinds-repo" })).events[0]?.event;
    if (project?.type !== "project.created") throw new Error("expected project");
    const parent = (await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude", title: "Lead" })).events[0]?.event;
    if (parent?.type !== "thread.created") throw new Error("expected thread");
    const parentId = parent.thread.id;

    const parentStarted = gate();
    const parentRelease = gate();
    claude.control.scriptFor(parentId, ...heldTurn(parentStarted, parentRelease, "Delegated both."));
    await engine.dispatch({ type: "turn.request", threadId: parentId, text: "split the work" });
    await parentStarted.promise;

    // the parent's turn runs while it delegates; each child's turn holds until released
    const sameStarted = gate();
    const sameRelease = gate();
    const otherStarted = gate();
    const otherRelease = gate();
    claude.control.script(...heldTurn(sameStarted, sameRelease, "Claude half done."));
    codex.control.script(...heldTurn(otherStarted, otherRelease, "Codex half done."));
    const delegate = async (provider: "claude" | "codex", title: string): Promise<string> => {
      const r = await engine.dispatch({ type: "thread.delegate", fromThreadId: parentId, provider, prompt: title, title, useWorktree: false });
      const created = r.events.find((x) => x.event.type === "thread.created")?.event;
      if (created?.type !== "thread.created") throw new Error("expected delegate");
      return created.thread.id;
    };
    const [sameId, otherId] = await Promise.all([delegate("claude", "Same kind"), delegate("codex", "Other kind")]);
    await Promise.all([sameStarted.promise, otherStarted.promise]);
    expect(claude.control.opened.map((o) => o.threadId)).toEqual([parentId, sameId]);
    expect(codex.control.opened.map((o) => o.threadId)).toEqual([otherId]);

    // the provider reactor cannot drain while the children hold their turns: wait for the parent's settle instead
    const parentSettled = new Promise<void>((resolve) => {
      const off = engine.subscribe((record) => {
        if (record.event.type === "turn.settled" && record.event.threadId === parentId) {
          off();
          resolve();
        }
      });
    });
    parentRelease.open();
    await parentSettled;
    let model = engine.getModel();
    expect(model.threads[parentId]?.status).toBe("idle");
    expect(model.threads[sameId]?.status).toBe("running");
    expect(model.threads[otherId]?.status).toBe("running");

    sameRelease.open();
    otherRelease.open();
    await app.reactor.drain();
    await app.delegation.drain();
    expect(engine.getModel().threads[sameId]?.status).toBe("idle");
    expect(engine.getModel().threads[otherId]?.status).toBe("idle");
    expect(clock.count()).toBe(1);

    claude.control.scriptFor(parentId, emit({ type: "settled", status: "completed" }));
    clock.fire();
    await app.delegation.drain();
    await app.reactor.drain();
    model = engine.getModel();
    const wakes = Object.values(model.messages).filter((m) => m.threadId === parentId && m.notification?.source === "delegate");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.notification?.summary).toBe("2 delegates finished");
    expect(wakes[0]?.text).toContain(`Delegate "Same kind" (claude) finished: completed. Last reply:\nClaude half done.`);
    expect(wakes[0]?.text).toContain(`Delegate "Other kind" (codex) finished: completed. Last reply:\nCodex half done.`);
    expect(model.turns[wakes[0]?.turnId ?? ""]?.status).toBe("completed");
  });
});
