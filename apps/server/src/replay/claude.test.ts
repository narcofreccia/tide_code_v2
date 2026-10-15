import { afterEach, describe, expect, it } from "vitest";
import { replayClaudeDriver } from "@tide/driver-testing";
import { bootReplay, loadReplay, type ReplayHarness } from "./harness.ts";

const open: ReplayHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

describe("claude replay: basic-turn", () => {
  it("replays the Agent SDK conversation through the real session and engine", async () => {
    const replay = loadReplay("claude", "basic-turn");
    const claude = replayClaudeDriver(replay);
    const h = await bootReplay([claude.driver]);
    open.push(h);

    const thread = await h.newThread("claude");
    const turn = await h.runTurn(thread.id, "ping");

    expect(turn.status).toBe("completed");
    expect(h.messages(thread.id)).toEqual([
      { role: "user", text: "ping" },
      { role: "assistant", text: "pong" },
    ]);
    expect(h.model().threads[thread.id]).toMatchObject({ status: "idle", nativeSessionId: "sess-1" });
    expect(claude.transport.calls).toHaveLength(1);
    replay.assertDrained();
  });
});
