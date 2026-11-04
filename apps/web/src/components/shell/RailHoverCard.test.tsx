import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { attachFakeStore, makeApproval, makeThread, modelWithTimeline, resetUi } from "../../testHarness.ts";
import { RailThreadRow } from "./RailThreadRow.tsx";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  resetUi();
  vi.useRealTimers();
});

function mount() {
  const thread = makeThread("t1", { title: "Fix login", branch: "tide/fix", baseBranch: "main" });
  attachFakeStore(modelWithTimeline(thread, [makeApproval("a1", { threadId: "t1" }), makeApproval("a2", { threadId: "t1" })]));
  render(
    <ul>
      <RailThreadRow thread={thread} />
    </ul>,
  );
  return document.querySelector<HTMLElement>("[data-rail-thread]")!;
}

describe("RailHoverCard", () => {
  it("appears after 400 ms with the pending summary and goes away on leave", () => {
    const row = mount();
    fireEvent.pointerEnter(row);
    act(() => void vi.advanceTimersByTime(399));
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    const card = screen.getByRole("tooltip");
    expect(card.textContent).toContain("tide/fix → main");
    expect(card.textContent).toContain("2 approvals");
    fireEvent.pointerLeave(row);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("never appears on a 200 ms hover", () => {
    const row = mount();
    fireEvent.pointerEnter(row);
    act(() => void vi.advanceTimersByTime(200));
    fireEvent.pointerLeave(row);
    act(() => void vi.advanceTimersByTime(1000));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
