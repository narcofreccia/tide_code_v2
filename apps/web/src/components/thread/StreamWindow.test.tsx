import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mergeActivities, residentModel, threadActivitiesOf, type ReadModel } from "@tide/contracts";
import type { ModelStore, ModelStoreState } from "@tide/client";
import { Stream } from "./Stream.tsx";
import { forgetAllScroll } from "../../lib/scrollMemory.ts";
import { attachModelStore } from "../../state/model.ts";
import { useChildReveal } from "../../state/childReveal.ts";
import { makeMessage, makeThread, makeTool, makeTurn, mockRpc, modelWithTurns, resetUi } from "../../testHarness.ts";

afterEach(() => {
  cleanup();
  resetUi();
  forgetAllScroll();
});

/** 20 settled turns: a prompt and one Bash call each. */
function fullModel(): ReadModel {
  const n = 20;
  const turns = Array.from({ length: n }, (_, i) => makeTurn(`u${i}`, { requestedAt: i + 1, startedAt: i + 1, settledAt: i + 2 }));
  const messages = turns.map((t, i) => makeMessage(`m${i}`, { turnId: t.id, text: `prompt ${i}`, createdAt: i + 1 }));
  const model = modelWithTurns(makeThread("t1"), turns, messages);
  model.threadTimeline["t1"] = [];
  for (let i = 0; i < n; i++) {
    const tool = makeTool(`a${i}`, { turnId: `u${i}`, toolName: "Bash", input: { command: `cmd-${i}` }, createdAt: i + 1 });
    model.activities[tool.id] = tool;
    model.threadTimeline["t1"].push({ kind: "message", id: `m${i}` }, { kind: "activity", id: tool.id });
  }
  return model;
}

/** A resident-scope store: starts without settled activities and merges what is fetched. */
function residentStore(full: ReadModel): ModelStore {
  let state: ModelStoreState = { model: residentModel(full), status: "open", lastError: null, ready: true, epoch: 1 };
  const listeners = new Set<() => void>();
  const set = (model: ReadModel): void => {
    state = { ...state, model };
    for (const l of [...listeners]) l();
  };
  return {
    getState: () => state,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    dispatch: async () => ({ seq: 0, events: [] }),
    dispose: () => undefined,
    mergeActivities: (activities) => set({ ...state.model, activities: mergeActivities(state.model.activities, activities) }),
    dropActivities: () => undefined,
  };
}

const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("Stream activity window (R24)", () => {
  it("renders the newest 15 turns, fills in their activities, and shows earlier turns on demand", async () => {
    const full = fullModel();
    const requested: string[][] = [];
    mockRpc({
      "thread.activities": ((p: { threadId: string; turnIds: string[] }) => {
        requested.push(p.turnIds);
        return { seq: full.seq, activities: threadActivitiesOf(full, p.threadId, p.turnIds) };
      }) as never,
    });
    attachModelStore(residentStore(full));
    render(<Stream threadId="t1" provider="claude" />);

    // messages of the window are there at once; earlier turns are not rendered
    expect(screen.getByText("prompt 19")).toBeDefined();
    expect(screen.getByText("prompt 5")).toBeDefined();
    expect(screen.queryByText("prompt 4")).toBeNull();
    await settle();
    expect(requested[0]).toHaveLength(15);
    expect(screen.getByText("cmd-19")).toBeDefined();
    expect(screen.queryByText("cmd-4")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show earlier turns (5)" }));
    await settle();
    expect(requested[1]).toEqual(["u0", "u1", "u2", "u3", "u4"]);
    expect(screen.getByText("prompt 0")).toBeDefined();
    expect(screen.getByText("cmd-0")).toBeDefined();
    expect(screen.queryByRole("button", { name: /Show earlier turns/ })).toBeNull();
  });

  it("offers a retry when the window cannot be fetched", async () => {
    const full = fullModel();
    let fail = true;
    mockRpc({
      "thread.activities": ((p: { threadId: string; turnIds: string[] }) => {
        if (fail) throw new Error("offline");
        return { seq: full.seq, activities: threadActivitiesOf(full, p.threadId, p.turnIds) };
      }) as never,
    });
    attachModelStore(residentStore(full));
    render(<Stream threadId="t1" provider="claude" />);
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("offline");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("cmd-19")).toBeDefined();
  });
});

describe("a 'reported' notice about a sub-agent in an unloaded turn (R24)", () => {
  it("links it anyway: a click loads the earlier turns and reveals the sub-agent", async () => {
    const full = fullModel();
    const scout = { id: "c0", threadId: "t1", turnId: "u0", kind: "child" as const, childKey: "k0", name: "Scout", status: "done" as const, report: "found it", createdAt: 1, updatedAt: 2 };
    full.activities[scout.id] = scout;
    full.threadTimeline["t1"]?.splice(1, 0, { kind: "activity", id: scout.id });
    full.messages["m19"] = makeMessage("m19", { turnId: "u19", createdAt: 30, notification: { source: "harness", summary: 'sub-agent "Scout" reported' } });
    const requested: string[][] = [];
    mockRpc({
      "thread.activities": ((p: { threadId: string; turnIds: string[] }) => {
        requested.push(p.turnIds);
        return { seq: full.seq, activities: threadActivitiesOf(full, p.threadId, p.turnIds) };
      }) as never,
    });
    attachModelStore(residentStore(full));
    render(<Stream threadId="t1" provider="claude" />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Scout" }));
    await settle();
    await settle();
    expect(requested.at(-1)).toHaveLength(5);
    expect(useChildReveal.getState().target).toMatchObject({ threadId: "t1", childKey: "k0" });
  });
});
