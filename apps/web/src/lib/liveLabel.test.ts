import { describe, expect, it } from "vitest";
import type { Activity, Message, ReadModel, Thread, Turn } from "@tide/contracts";
import { makeMessage, makeThread, makeTool, makeTurn, modelWith } from "../testHarness.ts";
import { displayToolName, liveLabelFor, liveLabelKey, parseLiveLabelKey, shortTarget } from "./liveLabel.ts";

const running = makeThread("t1", { status: "running", latestTurnId: "u1" });

/** One thread, its turns, and a timeline in the given order. */
function build(thread: Thread, turns: Turn[], entries: (Activity | Message)[] = []): ReadModel {
  const model = modelWith({ threads: { [thread.id]: thread } });
  for (const t of turns) model.turns[t.id] = t;
  model.threadTimeline[thread.id] = entries.map((e) => ("role" in e ? { kind: "message" as const, id: e.id } : { kind: "activity" as const, id: e.id }));
  for (const e of entries) {
    if ("role" in e) model.messages[e.id] = e;
    else model.activities[e.id] = e;
  }
  return model;
}

describe("liveLabelFor", () => {
  it("says a harness-initiated turn is continuing after a sub-agent reported", () => {
    const model = build(running, [makeTurn("u1", { status: "running" })], [
      makeMessage("m1", { role: "user", text: "x", notification: { source: "harness", summary: "s" } }),
    ]);
    expect(liveLabelFor(model, running)).toEqual({ text: "continuing after a sub-agent reported", kind: "thinking" });
  });

  it("names a running tool with the basename of its path", () => {
    const model = build(running, [makeTurn("u1", { status: "running" })], [
      makeTool("a1", { toolName: "Edit", input: { file_path: "/repo/src/routes/Splash.svelte" }, status: "running" }),
    ]);
    expect(liveLabelFor(model, running)).toEqual({ text: "Edit Splash.svelte", kind: "tool" });
  });

  it("clips a command to 40 characters, first line, no quotes", () => {
    const cmd = 'npm test -- --grep "a very long pattern that keeps going and going"\necho done';
    const model = build(running, [makeTurn("u1", { status: "running" })], [
      makeTool("a0", { toolName: "Read", status: "ok" }),
      makeTool("a1", { toolName: "Bash", input: { command: cmd }, status: "running" }),
    ]);
    const label = liveLabelFor(model, running);
    expect(label?.kind).toBe("tool");
    expect(label?.text.startsWith("Bash npm test -- --grep a very long")).toBe(true);
    expect(label?.text.length).toBeLessThanOrEqual("Bash ".length + 40);
    expect(label?.text).not.toContain('"');
  });

  it("prefers a running tool over a later finished one", () => {
    const model = build(running, [makeTurn("u1", { status: "running" })], [
      makeTool("a1", { toolName: "Bash", input: { command: "pnpm build" }, status: "running" }),
      makeTool("a2", { toolName: "Read", status: "ok" }),
    ]);
    expect(liveLabelFor(model, running)?.text).toBe("Bash pnpm build");
  });

  it("says Writing while the reply streams text", () => {
    const model = build(running, [makeTurn("u1", { status: "running" })], [
      makeMessage("m1", { role: "user", text: "go" }),
      makeMessage("m2", { role: "assistant", text: "Sure, ", streaming: true }),
    ]);
    expect(liveLabelFor(model, running)).toEqual({ text: "Writing", kind: undefined });
  });

  it("says Thinking while reasoning streams, and when the turn just started", () => {
    const reasoning = build(running, [makeTurn("u1", { status: "running" })], [
      makeMessage("m2", { role: "assistant", text: "", reasoning: "hmm", streaming: true }),
    ]);
    expect(liveLabelFor(reasoning, running)).toEqual({ text: "Thinking", kind: "thinking" });
    const fresh = build(running, [makeTurn("u1", { status: "requested" })], [makeMessage("m1", { role: "user", text: "go" })]);
    expect(liveLabelFor(fresh, running)).toEqual({ text: "Thinking", kind: "thinking" });
  });

  it("does not read a previous turn's running leftovers", () => {
    const model = build(running, [makeTurn("u0"), makeTurn("u1", { status: "running" })], [
      makeTool("a0", { turnId: "u0", toolName: "Bash", input: { command: "stale" }, status: "running" }),
    ]);
    expect(liveLabelFor(model, running)?.text).toBe("Thinking");
  });

  it("says Needs approval for a pending approval", () => {
    const thread = { ...running, attention: "approval" as const };
    expect(liveLabelFor(build(thread, [makeTurn("u1", { status: "running" })]), thread)).toEqual({ text: "Needs approval", kind: "approval" });
  });

  it("says Waiting for limit reset for a limited thread", () => {
    const thread = makeThread("t1", { limited: { resume: "reset", at: 1 } });
    expect(liveLabelFor(build(thread, []), thread)).toEqual({ text: "Waiting for limit reset", kind: "limited" });
  });

  it("says Stopping while an interrupt is pending", () => {
    const thread = { ...running, interrupting: true };
    expect(liveLabelFor(build(thread, [makeTurn("u1", { status: "running" })]), thread)?.kind).toBe("waiting");
  });

  it("says Queued for a turn waiting with nothing live", () => {
    const thread = makeThread("t1", { status: "interrupted", latestTurnId: "u1" });
    const model = build(thread, [makeTurn("u1", { status: "interrupted" }), makeTurn("u2", { status: "queued" })]);
    expect(liveLabelFor(model, thread)).toEqual({ text: "Queued", kind: "queued" });
  });

  it("is undefined for idle, settled or archived threads", () => {
    const idle = makeThread("t1", { latestTurnId: "u1" });
    expect(liveLabelFor(build(idle, [makeTurn("u1")]), idle)).toBeUndefined();
    const archived = { ...running, archivedAt: 2, attention: "approval" as const };
    expect(liveLabelFor(build(archived, [makeTurn("u1", { status: "running" })]), archived)).toBeUndefined();
  });
});

describe("liveLabel helpers", () => {
  it("shortens tool names and targets", () => {
    expect(displayToolName("mcp__tide__tide_delegate")).toBe("Tide_delegate");
    expect(displayToolName("mcp:github.search")).toBe("Search");
    expect(displayToolName("bash")).toBe("Bash");
    expect(shortTarget({ pattern: "TODO" })).toBe("TODO");
    expect(shortTarget({})).toBeUndefined();
  });

  it("round-trips through the store key", () => {
    for (const info of [undefined, { text: "Writing", kind: undefined }, { text: "Bash a\nb", kind: "tool" as const }]) {
      expect(parseLiveLabelKey(liveLabelKey(info))).toEqual(info);
    }
  });
});
