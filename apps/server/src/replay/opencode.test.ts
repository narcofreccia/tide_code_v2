import { afterEach, describe, expect, it } from "vitest";
import { replayOpencodeDriver } from "@tide/driver-testing";
import { bootReplay, loadReplay, type ReplayHarness } from "./harness.ts";

const open: ReplayHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

describe("opencode replay: rollback", () => {
  it("two turns, then thread.rollback reverts the second on the wire and completes", async () => {
    const replay = loadReplay("opencode", "rollback");
    const opencode = replayOpencodeDriver(replay);
    const h = await bootReplay([opencode.driver]);
    open.push(h);
    expect(replay.start).toMatchObject({ provider: "opencode", synthetic: true });

    const thread = await h.newThread("opencode");
    const first = await h.runTurn(thread.id, "first question");
    const second = await h.runTurn(thread.id, "second question");
    expect([first.status, second.status]).toEqual(["completed", "completed"]);
    expect(h.model().threads[thread.id]?.nativeSessionId).toBe("ses_1");
    expect(h.messages(thread.id).map((m) => m.text)).toEqual(["first question", "answer 1", "second question", "answer 2"]);

    await h.app.engine.dispatch({ type: "thread.rollback", threadId: thread.id, turnId: second.id, restoreFiles: false });
    await h.app.rollback.drain();

    const model = h.model();
    expect(h.events.map((e) => e.type)).toContain("rollback.requested");
    expect(h.events.filter((e) => e.type === "rollback.completed")).toHaveLength(1);
    expect(h.events.some((e) => e.type === "rollback.failed")).toBe(false);
    expect(model.threads[thread.id]?.rollback).toMatchObject({ status: "done" });
    expect(model.turns[second.id]?.rolledBack).toBe(true);
    expect(model.turns[first.id]?.rolledBack).not.toBe(true);

    // the wire carried exactly: revert to the user message of turn 2 without touching files, then commit
    const calls = opencode.transport.requests.map((r) => `${r.method} ${r.path}`);
    expect(calls.slice(-3)).toEqual(["POST /api/session/ses_1/revert/stage", "POST /api/session/ses_1/revert/commit", "GET /api/session/ses_1"]);
    expect(opencode.transport.requests.find((r) => r.path.endsWith("/revert/stage"))?.body).toEqual({ messageID: "msg_u2", files: false });
    replay.assertDrained();
  });
});
