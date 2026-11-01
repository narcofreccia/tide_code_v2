import { createElement, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { forgetAllScroll } from "../../lib/scrollMemory.ts";
import { PILL_DELAY_MS, SWITCH_GRACE_MS, useStreamScroll } from "./useStreamScroll.ts";

/**
 * jsdom has no layout: rows carry their height in `data-h`, the list stacks them, and
 * scrollTop / scrollHeight / rects are derived from that, clamped like a browser.
 */
const VIEWPORT = 400;
const tops = new WeakMap<Element, number>();
const heightOf = (el: Element): number => Number((el as HTMLElement).dataset.h ?? 0);
const contentHeight = (list: Element): number => [...list.children].reduce((sum, row) => sum + heightOf(row), 0);
const maxTop = (list: Element): number => Math.max(0, contentHeight(list) - VIEWPORT);

const resizeCallbacks = new Set<ResizeObserverCallback>();
class FakeResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeCallbacks.add(callback);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    resizeCallbacks.delete(this.callback);
  }
}

function fireResize(): void {
  act(() => {
    for (const cb of resizeCallbacks) cb([], {} as ResizeObserver);
  });
}

const olProto = HTMLOListElement.prototype;
const liProto = HTMLLIElement.prototype;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "Date"] });
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  Object.defineProperties(olProto, {
    scrollTop: {
      configurable: true,
      get(this: Element) {
        return tops.get(this) ?? 0;
      },
      set(this: Element, value: number) {
        tops.set(this, Math.max(0, Math.min(value, maxTop(this))));
      },
    },
    scrollHeight: { configurable: true, get: function (this: Element) { return Math.max(contentHeight(this), VIEWPORT); } },
    clientHeight: { configurable: true, get: () => VIEWPORT },
    clientWidth: { configurable: true, get: () => 400 },
    offsetWidth: { configurable: true, get: () => 410 },
    getBoundingClientRect: { configurable: true, value: () => ({ top: 0, bottom: VIEWPORT, left: 0, right: 410 }) },
  });
  Object.defineProperty(liProto, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      const list = this.parentElement!;
      let top = -list.scrollTop;
      for (const row of list.children) {
        if (row === this) break;
        top += heightOf(row);
      }
      return { top, bottom: top + heightOf(this), left: 0, right: 400 };
    },
  });
});

afterEach(() => {
  cleanup();
  for (const key of ["scrollTop", "scrollHeight", "clientHeight", "clientWidth", "offsetWidth", "getBoundingClientRect"]) {
    delete (olProto as unknown as Record<string, unknown>)[key];
  }
  delete (liProto as unknown as Record<string, unknown>).getBoundingClientRect;
  resizeCallbacks.clear();
  forgetAllScroll();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function Harness({ threadId, heights }: { threadId: string; heights: number[] }) {
  const ref = useRef<HTMLOListElement>(null);
  const { showNew, jumpToEnd } = useStreamScroll(ref, { threadId, rowsSignature: heights, hasRows: heights.length > 0 });
  return createElement(
    "div",
    null,
    createElement(
      "ol",
      { ref, "data-testid": "list" },
      heights.map((h, i) => createElement("li", { key: i, "data-h": h }, `row ${i}`)),
    ),
    showNew ? createElement("button", { type: "button", onClick: jumpToEnd }, "New text") : null,
  );
}

const rowsOf = (n: number, h = 100): number[] => Array.from({ length: n }, () => h);
const harness = (threadId: string, heights: number[]) => createElement(Harness, { key: threadId, threadId, heights });
const list = (): HTMLOListElement => screen.getByTestId("list") as HTMLOListElement;
const tick = (ms = 20): void => act(() => void vi.advanceTimersByTime(ms));

/** The user scrolls to `top` (the scroll event follows, after any programmatic hold). */
function userScroll(top: number): void {
  tick();
  list().scrollTop = top;
  fireEvent.scroll(list());
}

/** jsdom has no PointerEvent: a MouseEvent of the same type carries clientX */
function pointerDown(clientX: number): void {
  fireEvent(list(), new MouseEvent("pointerdown", { clientX, bubbles: true }));
}

function wheelUp(): void {
  fireEvent.wheel(list(), { deltaY: -120 });
}

describe("useStreamScroll", () => {
  it("starts at the bottom and pins every new row while following", () => {
    const view = render(harness("a", rowsOf(20)));
    expect(list().scrollTop).toBe(1600);
    view.rerender(harness("a", rowsOf(21)));
    expect(list().scrollTop).toBe(1700);
  });

  it("wheel-up releases: a new row does not move the view", () => {
    const view = render(harness("a", rowsOf(20)));
    wheelUp();
    userScroll(1500);
    view.rerender(harness("a", rowsOf(22)));
    expect(list().scrollTop).toBe(1500);
  });

  it("does not release on wheel-up when nothing overflows", () => {
    const view = render(harness("a", rowsOf(3)));
    wheelUp();
    view.rerender(harness("a", rowsOf(6)));
    expect(list().scrollTop).toBe(200);
  });

  it("releases on PageUp / Home / ArrowUp and on a scrollbar press, not on a press in the rows", () => {
    const view = render(harness("a", rowsOf(20)));
    pointerDown(100);
    view.rerender(harness("a", rowsOf(21)));
    expect(list().scrollTop).toBe(1700);

    pointerDown(405);
    view.rerender(harness("a", rowsOf(22)));
    expect(list().scrollTop).toBe(1700);

    userScroll(1800); // back to the end re-arms
    view.rerender(harness("a", rowsOf(23)));
    expect(list().scrollTop).toBe(1900);

    fireEvent.keyDown(list(), { key: "PageUp" });
    view.rerender(harness("a", rowsOf(24)));
    expect(list().scrollTop).toBe(1900);
  });

  it("scrolling back within 40px of the end re-arms and the next row pins", () => {
    const view = render(harness("a", rowsOf(20)));
    wheelUp();
    userScroll(1000);
    userScroll(1570); // 30px from the end
    view.rerender(harness("a", rowsOf(21)));
    expect(list().scrollTop).toBe(1700);
  });

  it("re-pins a content growth while following (composer, expanded rows, async blocks)", () => {
    render(harness("a", rowsOf(20)));
    (list().children[19] as HTMLElement).dataset.h = "300";
    fireResize();
    expect(list().scrollTop).toBe(1800);
  });

  it("while released, compensates a growth above the viewport and ignores one below", () => {
    render(harness("a", rowsOf(20)));
    wheelUp();
    userScroll(1030);
    (list().children[2] as HTMLElement).dataset.h = "250";
    fireResize();
    expect(list().scrollTop).toBe(1180);
    (list().children[18] as HTMLElement).dataset.h = "400";
    fireResize();
    expect(list().scrollTop).toBe(1180);
  });

  it("shows the pill 150ms after rows change while released, and hides it on re-arm", () => {
    const view = render(harness("a", rowsOf(20)));
    tick(SWITCH_GRACE_MS);
    view.rerender(harness("a", rowsOf(21)));
    tick(PILL_DELAY_MS * 2);
    expect(screen.queryByText("New text")).toBeNull(); // following: no pill

    wheelUp();
    userScroll(1000);
    view.rerender(harness("a", rowsOf(22)));
    tick(PILL_DELAY_MS - 1);
    expect(screen.queryByText("New text")).toBeNull();
    tick(1);
    expect(screen.getByText("New text")).toBeDefined();

    userScroll(1800);
    expect(screen.queryByText("New text")).toBeNull();
  });

  it("the pill jumps to the end and re-arms", () => {
    const view = render(harness("a", rowsOf(20)));
    tick(SWITCH_GRACE_MS);
    wheelUp();
    userScroll(500);
    view.rerender(harness("a", rowsOf(21)));
    tick(PILL_DELAY_MS);
    fireEvent.click(screen.getByText("New text"));
    expect(list().scrollTop).toBe(1700);
    expect(screen.queryByText("New text")).toBeNull();
    view.rerender(harness("a", rowsOf(22)));
    expect(list().scrollTop).toBe(1800);
  });

  it("restores each thread's position on switch, and goes to the bottom without one", () => {
    const view = render(harness("a", rowsOf(20)));
    wheelUp();
    userScroll(1030);
    tick(); // the save lands on the next frame

    view.rerender(harness("b", rowsOf(30)));
    expect(list().scrollTop).toBe(2600);

    view.rerender(harness("a", rowsOf(20)));
    expect(list().scrollTop).toBe(1030);
    // restored away from the end: released, so a new row stays put
    view.rerender(harness("a", rowsOf(21)));
    expect(list().scrollTop).toBe(1030);

    view.rerender(harness("b", rowsOf(31)));
    expect(list().scrollTop).toBe(2700); // b was following: back to its end
  });

  it("never shows the pill right after a switch", () => {
    const view = render(harness("a", rowsOf(20)));
    wheelUp();
    userScroll(800);
    tick();
    view.rerender(harness("b", rowsOf(5)));
    view.rerender(harness("a", rowsOf(20)));
    view.rerender(harness("a", rowsOf(21)));
    tick(SWITCH_GRACE_MS - 40);
    expect(screen.queryByText("New text")).toBeNull();
  });
});
