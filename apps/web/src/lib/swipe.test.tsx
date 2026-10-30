import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { lockAxis, SWIPE_COMMIT_PX, swipeOutcome, useSwipeRow } from "./swipe.ts";

// jsdom has no PointerEvent: a MouseEvent carrying pointerId keeps clientX/clientY
class TestPointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  constructor(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.pointerType = init.pointerType ?? "touch";
  }
}
vi.stubGlobal("PointerEvent", TestPointerEvent);

afterEach(cleanup);

describe("swipe thresholds", () => {
  it("commits only at 80px", () => {
    expect(swipeOutcome(SWIPE_COMMIT_PX - 1)).toBeUndefined();
    expect(swipeOutcome(80)).toBe("right");
    expect(swipeOutcome(-80)).toBe("left");
    expect(swipeOutcome(-79)).toBeUndefined();
  });
  it("locks to the dominant axis once it moves", () => {
    expect(lockAxis(4, 3)).toBeUndefined();
    expect(lockAxis(30, 10)).toBe("x");
    expect(lockAxis(10, -30)).toBe("y");
  });
});

function Row({ left, right }: { left: () => void; right: () => void }) {
  const swipe = useSwipeRow(left, right);
  return <div data-testid="row" data-reveal={swipe.reveal ?? ""} {...swipe.handlers} />;
}

function drag(to: { x: number; y: number }) {
  const row = screen.getByTestId("row");
  fireEvent.pointerDown(row, { pointerId: 1, clientX: 200, clientY: 100 });
  fireEvent.pointerMove(row, { pointerId: 1, clientX: 200 + to.x, clientY: 100 + to.y });
  return row;
}

describe("useSwipeRow", () => {
  it("fires onRight for a long right drag and onLeft for a long left drag", () => {
    const left = vi.fn();
    const right = vi.fn();
    render(<Row left={left} right={right} />);
    let row = drag({ x: 100, y: 5 });
    expect(row.dataset.reveal).toBe("right");
    fireEvent.pointerUp(row, { pointerId: 1, clientX: 300, clientY: 105 });
    expect(right).toHaveBeenCalledTimes(1);
    row = drag({ x: -100, y: 5 });
    fireEvent.pointerUp(row, { pointerId: 1, clientX: 100, clientY: 105 });
    expect(left).toHaveBeenCalledTimes(1);
  });
  it("does nothing for a short drag", () => {
    const left = vi.fn();
    const right = vi.fn();
    render(<Row left={left} right={right} />);
    const row = drag({ x: 60, y: 0 });
    fireEvent.pointerUp(row, { pointerId: 1, clientX: 260, clientY: 100 });
    expect(left).not.toHaveBeenCalled();
    expect(right).not.toHaveBeenCalled();
  });
  it("cancels when vertical movement dominates", () => {
    const right = vi.fn();
    render(<Row left={vi.fn()} right={right} />);
    const row = drag({ x: 20, y: 60 });
    fireEvent.pointerUp(row, { pointerId: 1, clientX: 320, clientY: 160 });
    expect(right).not.toHaveBeenCalled();
    expect(row.dataset.reveal).toBe("");
  });
});
