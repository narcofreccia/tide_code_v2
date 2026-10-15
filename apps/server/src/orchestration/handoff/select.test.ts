import { describe, it, expect } from "vitest";
import { emptyReadModel, replay, type EventRecord, type ReadModel } from "@tide/contracts";
import { collectItems, handoffBudget, handoffTurns, selectHandoff } from "./select.ts";

let seqCounter = 0;
const rec = (event: EventRecord["event"]): EventRecord => ({ seq: ++seqCounter, ts: seqCounter, event });

interface TurnSpec {
  id: string;
  at: number;
  user: string;
  assistant?: string;
  status?: "queued" | "completed";
  extra?: EventRecord["event"][];
}

function build(turns: TurnSpec[]): ReadModel {
  seqCounter = 0;
  const events: EventRecord[] = [
    rec({ type: "project.created", project: { id: "p1", title: "T", rootPath: "/x", createdAt: 1, updatedAt: 1 } }),
    rec({ type: "thread.created", thread: { id: "t1", projectId: "p1", title: "New", provider: "claude", mode: "approval-required", interaction: "default", status: "idle", createdAt: 2, updatedAt: 2 } }),
  ];
  for (const t of turns) {
    const queued = t.status === "queued";
    events.push(
      rec({
        type: "turn.requested",
        turn: { id: t.id, threadId: "t1", status: queued ? "queued" : "requested", requestedAt: t.at },
        userMessage: { id: `${t.id}-u`, threadId: "t1", turnId: t.id, role: "user", text: t.user, createdAt: t.at },
      }),
    );
    if (queued) continue;
    if (t.assistant !== undefined) {
      events.push(rec({ type: "assistant.delta", turnId: t.id, threadId: "t1", messageId: `${t.id}-a`, delta: t.assistant, at: t.at }));
    }
    for (const e of t.extra ?? []) events.push(rec(e));
    events.push(rec({ type: "turn.settled", turnId: t.id, threadId: "t1", status: "completed", settledAt: t.at }));
  }
  return replay(emptyReadModel(), events);
}

const tool = (id: string, turnId: string, toolName: string, input: unknown, output?: string): EventRecord["event"] => ({
  type: "activity.upserted",
  activity: { id, kind: "tool", threadId: "t1", turnId, toolUseId: `tu-${id}`, toolName, input, status: "ok", ...(output === undefined ? {} : { output }), createdAt: 5, updatedAt: 5 },
} as EventRecord["event"]);

describe("handoffBudget", () => {
  it("defaults to 16000 with an unknown window", () => {
    expect(handoffBudget()).toBe(16_000);
    expect(handoffBudget({ cap: Number.NaN })).toBe(16_000);
  });
  it("clamps the cap to [1024, 64000]", () => {
    expect(handoffBudget({ cap: 10 })).toBe(1_024);
    expect(handoffBudget({ cap: 1_000_000 })).toBe(64_000);
    expect(handoffBudget({ cap: 30_000 })).toBe(30_000);
  });
  it("leaves the reserve free when the window is the tighter bound", () => {
    // reserve = max(16000, 20000/4) = 16000 -> 4000 left, below the 16000 default cap
    expect(handoffBudget({ window: 20_000 })).toBe(4_000);
    // reserve = window/4 = 50000 -> 150000 left, cap wins
    expect(handoffBudget({ window: 200_000, cap: 64_000 })).toBe(64_000);
    expect(handoffBudget({ window: 10_000 })).toBe(0);
  });
  it("parses a string cap from the environment", () => {
    expect(handoffBudget({ cap: "2048" })).toBe(2_048);
    expect(handoffBudget({ cap: "junk" })).toBe(16_000);
  });
});

describe("handoffTurns", () => {
  const model = build([
    { id: "a", at: 1, user: "one", assistant: "r1" },
    { id: "b", at: 2, user: "two", assistant: "r2" },
    { id: "c", at: 3, user: "three", assistant: "r3" },
    { id: "q", at: 4, user: "queued", status: "queued" },
  ]);
  const ids = (turns: { id: string }[]): string[] => turns.map((t) => t.id);

  it("excludes queued turns", () => {
    expect(ids(handoffTurns(model, "t1"))).toEqual(["a", "b", "c"]);
  });
  it("excludes rolled-back turns", () => {
    const rolled = { ...model, turns: { ...model.turns, b: { ...model.turns["b"]!, rolledBack: true } } } as ReadModel;
    expect(ids(handoffTurns(rolled, "t1"))).toEqual(["a", "c"]);
  });
  it("sinceTurnId is exclusive and untilTurnId inclusive", () => {
    expect(ids(handoffTurns(model, "t1", { sinceTurnId: "a" }))).toEqual(["b", "c"]);
    expect(ids(handoffTurns(model, "t1", { untilTurnId: "b" }))).toEqual(["a", "b"]);
    expect(ids(handoffTurns(model, "t1", { sinceTurnId: "a", untilTurnId: "b" }))).toEqual(["b"]);
  });
  it("treats an unknown untilTurnId as all turns", () => {
    expect(ids(handoffTurns(model, "t1", { untilTurnId: "nope" }))).toEqual(["a", "b", "c"]);
  });
  it("ignores other threads", () => {
    expect(handoffTurns(model, "other")).toEqual([]);
  });
});

describe("collectItems", () => {
  it("collects messages, plans, shell commands, file edits and errors; skips noise", () => {
    const model = build([
      {
        id: "a",
        at: 1,
        user: "do it",
        assistant: "done",
        extra: [
          tool("x1", "a", "Bash", { command: "pnpm test" }, "all green\n"),
          tool("x2", "a", "Edit", { file_path: "/src/a.ts" }),
          tool("x3", "a", "Read", { file_path: "/src/skip.ts" }),
          tool("x4", "a", "Grep", { pattern: "foo" }),
          { type: "activity.upserted", activity: { id: "e1", kind: "error", threadId: "t1", turnId: "a", text: "boom", createdAt: 6, updatedAt: 6 } } as EventRecord["event"],
          { type: "plan.proposed", plan: { id: "pl1", threadId: "t1", turnId: "a", markdown: "# Plan", status: "proposed", createdAt: 7, updatedAt: 7 } },
        ],
      },
      { id: "b", at: 2, user: "   " },
    ]);
    const turns = handoffTurns(model, "t1");
    const items = collectItems(model, "t1", turns);
    expect(items.map((i) => [i.kind, i.text])).toEqual([
      ["user", "do it"],
      ["assistant", "done"],
      ["command", "$ pnpm test (ok)\nall green"],
      ["files", "/src/a.ts"],
      ["error", "boom"],
      ["plan", "# Plan"],
    ]);
  });
  it("clips long command output", () => {
    const model = build([{ id: "a", at: 1, user: "go", extra: [tool("x1", "a", "Bash", { command: "ls" }, "z".repeat(5_000))] }]);
    const items = collectItems(model, "t1", handoffTurns(model, "t1"));
    const cmd = items.find((i) => i.kind === "command");
    expect(cmd?.text.length).toBeLessThan(700);
    expect(cmd?.text.endsWith("…")).toBe(true);
  });
  it("only includes items of the given turns", () => {
    const model = build([
      { id: "a", at: 1, user: "first", assistant: "r1" },
      { id: "b", at: 2, user: "second", assistant: "r2" },
    ]);
    const items = collectItems(model, "t1", handoffTurns(model, "t1", { sinceTurnId: "a" }));
    expect(items.map((i) => i.turnId)).toEqual(["b", "b"]);
  });
});

describe("selectHandoff", () => {
  const body = (s: string): string => s.repeat(200);
  const model = build([
    { id: "t1", at: 1, user: body("a"), assistant: body("A") },
    { id: "t2", at: 2, user: body("b"), assistant: body("B") },
    { id: "t3", at: 3, user: body("c"), assistant: body("C") },
    { id: "t4", at: 4, user: body("d"), assistant: body("D") },
  ]);
  const turns = handoffTurns(model, "t1");
  const render = (label: string, n: number, text: string): number => Buffer.byteLength(`[${label}; turn=${n}]\n${text}\n`, "utf8");
  const tight = render("Historical user", 4, body("d")) + render("Historical assistant", 4, body("D")) + render("Historical user", 1, body("a"));
  const base = { threadId: "t1", toProvider: "codex" as const, strategy: "full" as const, turns, sourceTitle: "Src" };

  it("keeps latest user, latest assistant and first user first; omits the middle", () => {
    const sel = selectHandoff(model, { ...base, budgetBytes: tight });
    expect(sel.text).toContain(body("d"));
    expect(sel.text).toContain(body("D"));
    expect(sel.text).toContain(body("a"));
    expect(sel.text).not.toContain(body("b"));
    expect(sel.text).not.toContain(body("c"));
    expect(sel.text).not.toContain(body("A"));
    expect(sel.coveredTurnIds).toEqual(["t1", "t4"]);
    expect(sel.omittedTurnIds).toEqual(["t2", "t3"]);
  });
  it("renders chronologically", () => {
    const sel = selectHandoff(model, { ...base, budgetBytes: tight });
    const iFirst = sel.text.indexOf(body("a"));
    const iUser = sel.text.indexOf(body("d"));
    const iAssistant = sel.text.indexOf(body("D"));
    expect(iFirst).toBeGreaterThan(-1);
    expect(iFirst).toBeLessThan(iUser);
    expect(iUser).toBeLessThan(iAssistant);
  });
  it("mentions tide_thread_read only when something was omitted", () => {
    expect(selectHandoff(model, { ...base, budgetBytes: tight }).text).toContain("tide_thread_read");
    const all = selectHandoff(model, { ...base, budgetBytes: 1_000_000 });
    expect(all.text).not.toContain("tide_thread_read");
    expect(all.omittedTurnIds).toEqual([]);
    expect(all.coveredTurnIds).toEqual(["t1", "t2", "t3", "t4"]);
  });
  it("uses a different header for the delta strategy", () => {
    const full = selectHandoff(model, { ...base, budgetBytes: 1_000_000 }).text;
    const delta = selectHandoff(model, { ...base, strategy: "delta", budgetBytes: 1_000_000 }).text;
    expect(full).toContain('history of thread "Src"');
    expect(delta).toContain("(delta)");
    expect(delta).not.toContain('history of thread "Src"');
  });
  it("fills the remaining budget newest first", () => {
    const sel = selectHandoff(model, { ...base, budgetBytes: tight + render("Historical assistant", 3, body("C")) });
    expect(sel.text).toContain(body("C"));
    expect(sel.coveredTurnIds).toEqual(["t1", "t3", "t4"]);
  });
});
