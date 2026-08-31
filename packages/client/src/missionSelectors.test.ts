import { describe, expect, it } from "vitest";
import { emptyReadModel, type ReadModel, type Thread, type Turn } from "@tide/contracts";
import { selectPrCounts, selectRecentThreads, selectRunningThreads } from "./selectors.ts";

const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({
  id,
  projectId: "p1",
  title: `Thread ${id}`,
  provider: "claude",
  mode: "approval-required",
  interaction: "default",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

const turn = (id: string, patch: Partial<Turn> = {}): Turn => ({
  id,
  threadId: "t1",
  status: "running",
  requestedAt: 100,
  ...patch,
});

function build(threads: Thread[], turns: Turn[] = []): ReadModel {
  const model = emptyReadModel();
  for (const t of threads) model.threads[t.id] = t;
  for (const t of turns) model.turns[t.id] = t;
  return model;
}

describe("selectRunningThreads", () => {
  it("returns running threads with the active turn's start, longest-running first", () => {
    const model = build(
      [
        thread("t1", { status: "running", latestTurnId: "u1" }),
        thread("t2", { status: "running", latestTurnId: "u2" }),
        thread("t3", { status: "idle", latestTurnId: "u3" }),
      ],
      [
        turn("u1", { threadId: "t1", startedAt: 500 }),
        turn("u2", { threadId: "t2", requestedAt: 200 }),
        turn("u3", { threadId: "t3", status: "completed" }),
      ],
    );
    const running = selectRunningThreads(model);
    expect(running.map((r) => r.thread.id)).toEqual(["t2", "t1"]);
    expect(running.map((r) => r.startedAt)).toEqual([200, 500]);
  });

  it("skips archived threads and threads whose turn already settled, and scopes by project", () => {
    const model = build(
      [
        thread("t1", { status: "running", latestTurnId: "u1", archivedAt: 9 }),
        thread("t2", { status: "running", latestTurnId: "u2" }),
        thread("t3", { status: "running", projectId: "p2", latestTurnId: "u3" }),
        thread("t4", { status: "running" }),
      ],
      [
        turn("u1", { threadId: "t1" }),
        turn("u2", { threadId: "t2", status: "requested" }),
        turn("u3", { threadId: "t3" }),
      ],
    );
    expect(selectRunningThreads(model).map((r) => r.thread.id)).toEqual(["t2", "t3"]);
    expect(selectRunningThreads(model, "p1").map((r) => r.thread.id)).toEqual(["t2"]);
  });
});

describe("selectRecentThreads", () => {
  it("takes the newest top-level threads of one project", () => {
    const model = build([
      thread("a", { updatedAt: 10 }),
      thread("b", { updatedAt: 30 }),
      thread("c", { updatedAt: 20 }),
      thread("d", { updatedAt: 40, archivedAt: 1 }),
      thread("e", { updatedAt: 50, role: "expert" }),
      thread("f", { updatedAt: 60, projectId: "p2" }),
      thread("g", { updatedAt: 5 }),
    ]);
    expect(selectRecentThreads(model, "p1").map((t) => t.id)).toEqual(["b", "c", "a"]);
    expect(selectRecentThreads(model, "p1", 1).map((t) => t.id)).toEqual(["b"]);
  });
});

describe("selectPrCounts", () => {
  it("counts PRs by state over the project's live threads", () => {
    const pr = (state: "open" | "merged" | "closed") => ({
      url: `https://x/${state}`,
      number: 1,
      state,
      updatedAt: 1,
    });
    const model = build([
      thread("a", { pr: pr("open") }),
      thread("b", { pr: pr("open") }),
      thread("c", { pr: pr("merged") }),
      thread("d", { pr: pr("closed"), archivedAt: 2 }),
      thread("e", { pr: pr("open"), projectId: "p2" }),
      thread("f"),
    ]);
    expect(selectPrCounts(model, "p1")).toEqual({ open: 2, merged: 1, closed: 0 });
  });
});
