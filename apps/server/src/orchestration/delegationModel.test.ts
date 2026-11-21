import { describe, expect, it } from "vitest";
import type { Thread } from "@tide/contracts";
import { openDatabase } from "../db/sqlite.ts";
import { DelegationReactor, delegatesFinishedText, unlistedModelOf, type CancelTimer, type ListedModelsOf } from "./delegation.ts";
import { Engine } from "./engine.ts";
import { EventStore } from "./store.ts";

// R23: a delegate that died on a model its harness does not list tells the parent which ids would work.

const codexIds = ["gpt-6.2-sol", "gpt-6.1"];
const listed: ListedModelsOf = (child) => (child.provider === "codex" ? { harness: "codex", ids: codexIds, userDefault: "gpt-6.1" } : undefined);
const child = (model?: string): Thread => ({
  id: "c1",
  projectId: "p",
  title: "Child",
  provider: "codex",
  ...(model !== undefined ? { model } : {}),
  mode: "auto",
  interaction: "default",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
});

describe("unlistedModelOf", () => {
  it("names the model and the listed ids when an errored delegate ran an unlisted model", () => {
    expect(unlistedModelOf(child("gpt-6.2"), "error", listed)).toEqual({ model: "gpt-6.2", harness: "codex", ids: codexIds });
  });

  it("stays out of it for a listed model, no model, the user's default, another outcome, or no list", () => {
    expect(unlistedModelOf(child("gpt-6.1"), "error", listed)).toBeUndefined();
    expect(unlistedModelOf(child(), "error", listed)).toBeUndefined();
    expect(unlistedModelOf(child("gpt-6.2"), "completed", listed)).toBeUndefined();
    expect(unlistedModelOf(child("gpt-6.2"), "error", undefined)).toBeUndefined();
    expect(unlistedModelOf(child("gpt-6.2"), "error", () => ({ harness: "codex", ids: [] }))).toBeUndefined();
    expect(unlistedModelOf(child("my-default"), "error", () => ({ harness: "codex", ids: codexIds, userDefault: "my-default" }))).toBeUndefined();
  });
});

describe("delegatesFinishedText — model line", () => {
  it("adds one line after the reply", () => {
    const text = delegatesFinishedText([
      { threadId: "t1", title: "Port", provider: "codex", outcome: "error", error: "model not found", lastReply: "…", unlistedModel: { model: "gpt-6.2", harness: "codex", ids: codexIds } },
    ]);
    expect(text).toBe(
      [
        `Delegate "Port" (codex) finished: error (model not found). Last reply:`,
        "…",
        "Its model `gpt-6.2` is not one codex lists (gpt-6.2-sol, gpt-6.1). Delegate again with a listed id, or omit `model` for the default.",
        "Use tide_delegate_status / tide_thread_read t1 for details.",
      ].join("\n"),
    );
  });
});

describe("DelegationReactor — model failure wake-up", () => {
  async function run(model: string | undefined): Promise<string> {
    const engine = new Engine({ store: new EventStore(await openDatabase(":memory:")), now: () => 1_000 });
    const project = (await engine.dispatch({ type: "project.create", title: "P", rootPath: "/repo" })).events[0]?.event;
    if (project?.type !== "project.created") throw new Error("expected project");
    const parent = (await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude", title: "Lead" })).events[0]?.event;
    if (parent?.type !== "thread.created") throw new Error("expected thread");
    const timers: (() => void)[] = [];
    const schedule = (fn: () => void): CancelTimer => {
      timers.push(fn);
      return () => undefined;
    };
    const reactor = new DelegationReactor({ engine, schedule, listedModels: listed, log: () => undefined });
    reactor.start();
    const r = await engine.dispatch({ type: "thread.delegate", fromThreadId: parent.thread.id, provider: "codex", prompt: "go", title: "Port", ...(model !== undefined ? { model } : {}) });
    const requested = r.events.find((x) => x.event.type === "turn.requested")?.event;
    if (requested?.type !== "turn.requested") throw new Error("expected a delegate turn");
    await engine.dispatch({ type: "turn.start", turnId: requested.turn.id, provider: "codex" });
    await engine.dispatch({ type: "turn.settle", turnId: requested.turn.id, status: "error", error: "There's an issue with the selected model" });
    await reactor.drain();
    for (const fire of timers.splice(0)) fire();
    await reactor.drain();
    reactor.stop();
    const wake = Object.values(engine.getModel().messages).find((m) => m.threadId === parent.thread.id && m.notification !== undefined);
    return wake?.text ?? "";
  }

  it("says which ids codex lists when the delegate died on an unlisted model", async () => {
    expect(await run("gpt-6.2")).toContain("Its model `gpt-6.2` is not one codex lists (gpt-6.2-sol, gpt-6.1). Delegate again with a listed id, or omit `model` for the default.");
  });

  it("adds nothing when the model was listed or absent", async () => {
    expect(await run("gpt-6.2-sol")).not.toContain("Its model");
    const none = await run(undefined);
    expect(none).toContain("finished: error");
    expect(none).not.toContain("Its model");
  });
});
