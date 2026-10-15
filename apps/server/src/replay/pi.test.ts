import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatePiLogin, replayCodexDriver, replayPiDriver } from "@tide/driver-testing";
import { bootReplay, loadReplay, type ReplayHarness } from "./harness.ts";

const open: ReplayHarness[] = [];
let restoreEnv: (() => void) | undefined;
beforeEach(() => {
  restoreEnv = isolatePiLogin();
});
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
  restoreEnv?.();
});

describe("pi replay: handoff-inline", () => {
  it("a thread switched from codex to pi starts pi's first prompt with the context handoff", async () => {
    const codexReplay = loadReplay("codex", "basic-turn");
    const piReplay = loadReplay("pi", "handoff-inline");
    expect(piReplay.start.synthetic).toBe(true);
    const h = await bootReplay([replayCodexDriver(codexReplay).driver, replayPiDriver(piReplay).driver]);
    open.push(h);

    // history on codex
    const thread = await h.newThread("codex");
    const first = await h.runTurn(thread.id, "add a --verbose flag to the CLI");
    expect(first.status).toBe("completed");

    // switch harness: pi has never seen this thread, so the next turn carries a handoff
    await h.app.engine.dispatch({ type: "thread.update", threadId: thread.id, provider: "pi" });
    const recorded = h.events.find((e) => e.type === "handoff.recorded");
    expect(recorded).toMatchObject({ type: "handoff.recorded", handoff: { fromProvider: "codex", toProvider: "pi", strategy: "full" } });

    const second = await h.runTurn(thread.id, "now cover it with a test");
    expect(second).toMatchObject({ status: "completed", provider: "pi" });

    // the very first prompt pi ever received carries the history, then the user's own text
    const prompt = piReplay.only().written.find((frame) => (frame as { type?: string }).type === "prompt") as { message: string };
    expect(prompt.message.startsWith("# Context handoff")).toBe(true);
    expect(prompt.message).toContain("add a --verbose flag to the CLI");
    expect(prompt.message.endsWith("User message:\nnow cover it with a test")).toBe(true);
    expect(h.events.find((e) => e.type === "handoff.delivered")).toMatchObject({ delivery: "inline" });
    expect(h.messages(thread.id).at(-1)).toEqual({ role: "assistant", text: "Added a test for --verbose." });
    expect(h.model().threads[thread.id]).toMatchObject({ provider: "pi", nativeSessionId: "/tmp/pi-sessions/handoff.jsonl" });
    codexReplay.assertDrained();
    piReplay.assertDrained();
  });
});
