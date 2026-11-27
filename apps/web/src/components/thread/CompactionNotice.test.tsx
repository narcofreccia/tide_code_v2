import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Activity } from "@tide/contracts";
import { attachFakeStore, makeThread, makeTurn, modelWithTimeline, resetUi } from "../../testHarness.ts";
import { compactionOf, isCompactPrompt } from "../../lib/compaction.ts";
import { Stream } from "./Stream.tsx";

afterEach(() => {
  cleanup();
  resetUi();
});

const note = (id: string, text: string, patch: Partial<Activity> = {}): Activity =>
  ({ id, threadId: "t1", turnId: "u1", kind: "info", text, createdAt: 1, updatedAt: 1, ...patch }) as Activity;

function mount(entries: Activity[], status: "running" | "completed" = "completed") {
  const model = modelWithTimeline(makeThread("t1", { latestTurnId: "u1" }), entries);
  model.turns.u1 = makeTurn("u1", { status });
  attachFakeStore(model);
  render(<Stream threadId="t1" provider="claude" />);
}

describe("compaction notice", () => {
  it("recognises every driver's wording and the /compact prompt", () => {
    expect(compactionOf(note("a", "Context compacted (manual) · 182k → 21k tokens"))).toEqual({ phase: "done", text: "Context compacted · 182k → 21k tokens" });
    expect(compactionOf(note("a", "Context compacted"))?.phase).toBe("done");
    expect(compactionOf(note("a", "Compacting conversation…"))?.phase).toBe("running");
    expect(compactionOf(note("a", "Compacting context (threshold)"))?.phase).toBe("running");
    expect(compactionOf(note("a", "Rate limit rejected"))).toBeUndefined();
    expect(compactionOf(note("a", "Context compacted", { kind: "error" }))).toBeUndefined();
    expect(isCompactPrompt(" /compact ")).toBe(true);
    expect(isCompactPrompt("/compact keep the API notes")).toBe(true);
    expect(isCompactPrompt("/compactify")).toBe(false);
  });

  it("draws a visible divider with the token figures, not a folded harness event", () => {
    mount([note("i1", "claude: system/one", { payload: {} } as Partial<Activity>), note("i2", "Context compacted (manual) · 182k → 21k tokens")]);
    const row = screen.getByText("Context compacted · 182k → 21k tokens");
    expect(row.closest("li")?.getAttribute("data-compaction")).toBe("done");
    expect(row.getAttribute("title")).toBe("Context compacted (manual) · 182k → 21k tokens");
  });

  it("shimmers while compacting, and goes still once the turn settled", () => {
    mount([note("i1", "Compacting conversation…")], "running");
    expect(document.querySelector("[data-compaction=running] [data-live-label]")?.textContent).toBe("Compacting conversation…");
    cleanup();
    mount([note("i1", "Compacting conversation…")], "completed");
    expect(document.querySelector("[data-compaction=running] [data-live-label]")).toBeNull();
  });

  it("a /compact turn on a harness that reports nothing (Antigravity) still shimmers, then reads compacted", () => {
    const quiet = (status: "running" | "completed" | "interrupted") => {
      const model = modelWithTimeline(makeThread("t1", { latestTurnId: "u1" }), []);
      model.messages.m1 = { id: "m1", threadId: "t1", turnId: "u1", role: "user", text: "/compact", createdAt: 1 } as never;
      model.threadTimeline.t1 = [{ kind: "message", id: "m1" }];
      model.turns.u1 = makeTurn("u1", { status });
      attachFakeStore(model);
      render(<Stream threadId="t1" provider="antigravity" />);
    };
    quiet("running");
    expect(document.querySelector("[data-compaction=running] [data-live-label]")?.textContent).toBe("Compacting conversation…");
    cleanup();
    quiet("completed");
    expect(document.querySelector("[data-compaction=done]")?.textContent).toBe("Context compacted");
    cleanup();
    quiet("interrupted");
    expect(document.querySelector("[data-compaction]")).toBeNull();
  });

  it("claims no compaction when the harness answered /compact with text (agy on an empty session)", () => {
    const model = modelWithTimeline(makeThread("t1", { latestTurnId: "u1" }), []);
    model.messages.m1 = { id: "m1", threadId: "t1", turnId: "u1", role: "user", text: "/compact", createdAt: 1 } as never;
    model.messages.m2 = { id: "m2", threadId: "t1", turnId: "u1", role: "assistant", text: "There is no history to compact yet.", createdAt: 2 } as never;
    model.threadTimeline.t1 = [{ kind: "message", id: "m1" }, { kind: "message", id: "m2" }];
    model.turns.u1 = makeTurn("u1", { status: "completed" });
    attachFakeStore(model);
    render(<Stream threadId="t1" provider="antigravity" />);
    expect(document.querySelector("[data-compaction]")).toBeNull();
  });

  it("shows one row when a harness reports start and end separately", () => {
    mount([note("i1", "Compacting context (manual)"), note("i2", "Context compacted")]);
    expect(document.querySelectorAll("[data-compaction]")).toHaveLength(1);
  });
});
