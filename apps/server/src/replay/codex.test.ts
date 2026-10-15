import { afterEach, describe, expect, it } from "vitest";
import { replayCodexDriver } from "@tide/driver-testing";
import { bootReplay, loadReplay, type ReplayHarness } from "./harness.ts";

const open: ReplayHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function boot(scenario: string) {
  const replay = loadReplay("codex", scenario);
  const codex = replayCodexDriver(replay);
  const h = await bootReplay([codex.driver]);
  open.push(h);
  return { h, replay, codex };
}

describe("codex replay: turn-with-approval", () => {
  it("parks the harness's approval as a card, answers the same json-rpc id and completes the turn", async () => {
    const { h, replay, codex } = await boot("turn-with-approval");
    expect(replay.start.synthetic).toBe(true);
    const thread = await h.newThread("codex");
    const turnId = await h.request(thread.id, "remove the build directory");

    await h.until((m) => Object.values(m.activities).some((a) => a.kind === "approval" && a.status === "pending"));
    const card = h.activities(thread.id).find((a) => a.kind === "approval");
    expect(card).toMatchObject({ kind: "approval", toolName: "Bash", requestId: "srv-1", status: "pending", input: { command: "rm -rf build", cwd: "/repo" } });
    expect(h.model().threads[thread.id]?.status).toBe("running");
    // nothing past the approval has been replayed: the harness is waiting for the answer
    expect(replay.only().remaining).toBe(1);

    await h.app.engine.dispatch({ type: "approval.respond", threadId: thread.id, requestId: "srv-1", decision: "accept" });
    await h.app.reactor.drain();

    const model = h.model();
    expect(model.turns[turnId]?.status).toBe("completed");
    expect(model.threads[thread.id]).toMatchObject({ status: "idle", nativeSessionId: "thread-1" });
    expect(h.activities(thread.id).find((a) => a.kind === "approval")).toMatchObject({ status: "resolved", decision: "accept" });
    expect(h.messages(thread.id)).toEqual([
      { role: "user", text: "remove the build directory" },
      { role: "assistant", text: "Removed build/." },
    ]);
    expect(codex.transport.children).toHaveLength(1);
    expect(codex.transport.children[0]?.call).toMatchObject({ args: ["app-server"] });
    replay.assertDrained();
  });
});

describe("codex replay: steer-mid-turn", () => {
  it("sends turn/steer for a message typed mid-turn and the turn settles exactly once", async () => {
    const { h, replay, codex } = await boot("steer-mid-turn");
    const thread = await h.newThread("codex");
    const turnId = await h.request(thread.id, "build the feature");

    await h.until((m) => (m.threadMessages[thread.id] ?? []).some((id) => m.messages[id]?.role === "assistant"));
    // the harness is parked waiting for the steer
    expect(replay.transports[0]?.remaining).toBe(1);
    await h.app.engine.dispatch({ type: "turn.steer", threadId: thread.id, text: "use tabs instead" });
    await h.app.reactor.drain();

    expect(codex.transport.children.map((child) => child.transport.name)).toEqual(["main", "status-probe"]);
    const model = h.model();
    expect(h.events.some((e) => e.type === "turn.steer-fell-back")).toBe(false);
    expect(h.events.filter((e) => e.type === "turn.steered")).toHaveLength(1);
    expect(h.events.filter((e) => e.type === "turn.settled")).toHaveLength(1);
    expect(Object.keys(model.turns)).toEqual([turnId]);
    expect(model.turns[turnId]?.status).toBe("completed");
    // the steer is a message in the same turn, not a new one
    expect(h.messages(thread.id)).toEqual([
      { role: "user", text: "build the feature" },
      { role: "assistant", text: "Starting with spaces. Switched to tabs." },
      { role: "user", text: "use tabs instead" },
    ]);
    replay.assertDrained();
  });
});
