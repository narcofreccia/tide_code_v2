import { createElement, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { forgetAllScroll, rememberScroll } from "../../lib/scrollMemory.ts";
import { CONFIRM_MS, MESSAGE_SENT_EVENT, PILL_DELAY_MS, SWITCH_GRACE_MS, useStreamScroll } from "./useStreamScroll.ts";

/**
 * jsdom has no layout: rows carry their height in `data-h`, the list stacks them, and
 * scrollTop / scrollHeight / rects are derived from that, clamped like a browser.
 */
const VIEWPORT = 400;
const tops = new WeakMap<Element, number>();
const heightOf = (el: Element): number => Number((el as HTMLElement).dataset.h ?? 0);
const contentHeight = (list: Element): number => [...list.children].reduce((sum, row) => sum + heightOf(row), 0);
const maxTop = (list: Element): number => Math.max(0, contentHeight(list) - VIEWPORT);

const observers = new Set<FakeResizeObserver>();
class FakeResizeObserver {
  callback: ResizeObserverCallback;
  targets = new Map<Element, ResizeObserverOptions | undefined>();
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    observers.add(this);
  }
  observe(target: Element, options?: ResizeObserverOptions): void {
    this.targets.set(target, options);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    observers.delete(this);
  }
}

/** Every observer fires, or only those observing `target`. */
function fireResize(target?: Element): void {
  act(() => {
    for (const o of observers) if (target === undefined || o.targets.has(target)) o.callback([], {} as ResizeObserver);
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
  observers.clear();
  forgetAllScroll();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function Harness({ threadId, heights, extra }: { threadId: string; heights: number[]; extra?: number }) {
  const ref = useRef<HTMLOListElement>(null);
  const { showNew, jumpToEnd } = useStreamScroll(ref, { threadId, rowsSignature: heights, hasRows: heights.length > 0 });
  return createElement(
    "div",
    null,
    createElement(
      "ol",
      { ref, "data-testid": "list" },
      heights.map((h, i) => createElement("li", { key: i, "data-h": h, "data-row-key": `m${i}` }, `row ${i}`)),
      // a row mounted by its own render, not by a rows change (a handoff card)
      extra === undefined ? null : createElement("li", { key: "extra", "data-h": extra, "data-testid": "extra" }, "extra"),
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

  it("restores to a remembered rowKey before the index", () => {
    rememberScroll("a", { entryId: "0", rowKey: "m10", offsetWithinEntry: 0, atEnd: false });
    render(harness("a", rowsOf(20)));
    expect(list().scrollTop).toBe(1000);
  });

  it("tide:scroll-to scrolls the keyed row into view and releases following", () => {
    const view = render(harness("a", rowsOf(20)));
    expect(list().scrollTop).toBe(1600);
    act(() => void window.dispatchEvent(new CustomEvent("tide:scroll-to", { detail: { threadId: "a", rowKey: "m3" } })));
    expect(list().scrollTop).toBe(300);
    view.rerender(harness("a", rowsOf(22)));
    expect(list().scrollTop).toBe(300);
  });
});

/** A scroller inside the last row (live reasoning, tool output, a diff) at `top`. */
function innerScroller(top: number): HTMLElement {
  const inner = document.createElement("pre");
  inner.style.overflowY = "auto";
  Object.defineProperties(inner, {
    scrollTop: { configurable: true, value: top, writable: true },
    scrollHeight: { configurable: true, value: 600 },
    clientHeight: { configurable: true, value: 200 },
  });
  list().lastElementChild!.appendChild(inner);
  return inner;
}

function touch(type: "touchStart" | "touchMove" | "touchEnd", clientY?: number): void {
  fireEvent[type](list(), { touches: clientY === undefined ? [] : [{ clientY }] });
}

describe("useStreamScroll: only a real upward gesture releases", () => {
  it("wheel-up over a nested scroller that can still go up does not release; at its top it does", () => {
    const view = render(harness("a", rowsOf(20)));
    const inner = innerScroller(50);
    fireEvent.wheel(inner, { deltaY: -120 });
    view.rerender(harness("a", rowsOf(21)));
    expect(list().scrollTop).toBe(1700);

    inner.scrollTop = 0;
    fireEvent.wheel(inner, { deltaY: -120 });
    view.rerender(harness("a", rowsOf(22)));
    expect(list().scrollTop).toBe(1700);
  });

  it("a mostly sideways wheel and a ctrl+wheel (pinch) do not release", () => {
    const view = render(harness("a", rowsOf(20)));
    fireEvent.wheel(list(), { deltaY: -6, deltaX: -80 });
    fireEvent.wheel(list(), { deltaY: -120, ctrlKey: true });
    view.rerender(harness("a", rowsOf(21)));
    expect(list().scrollTop).toBe(1700);
  });

  it("a wheel-up that moved nothing is undone after the gesture's last input, and the next row pins", () => {
    const view = render(harness("a", rowsOf(20)));
    wheelUp();
    view.rerender(harness("a", rowsOf(21)));
    expect(list().scrollTop).toBe(1600);
    tick(CONFIRM_MS - 20);
    wheelUp(); // the same gesture: the check waits for its last input
    tick(CONFIRM_MS - 1);
    expect(list().scrollTop).toBe(1600);
    tick(1);
    expect(list().scrollTop).toBe(1700);
    view.rerender(harness("a", rowsOf(22)));
    expect(list().scrollTop).toBe(1800);
  });

  it("a wheel-up followed by a real scroll up stays released, even a small one near the end", () => {
    const view = render(harness("a", rowsOf(20)));
    wheelUp();
    userScroll(1570); // 30px up: inside the 40px band, still a deliberate move
    tick(CONFIRM_MS * 2);
    view.rerender(harness("a", rowsOf(21)));
    expect(list().scrollTop).toBe(1570);
  });

  it("stays released when the browser applied the scroll before the wheel event reached us", () => {
    const view = render(harness("a", rowsOf(20)));
    tick();
    list().scrollTop = 1000; // passive listener: the compositor scrolled first
    wheelUp();
    fireEvent.scroll(list());
    tick(CONFIRM_MS);
    view.rerender(harness("a", rowsOf(21)));
    expect(list().scrollTop).toBe(1000);
  });

  it("a reverse flick of a few px at the end is undone", () => {
    const view = render(harness("a", rowsOf(20)));
    wheelUp();
    userScroll(1597);
    tick(CONFIRM_MS);
    view.rerender(harness("a", rowsOf(21)));
    expect(list().scrollTop).toBe(1700);
  });

  it("our own compensation while released is not counted as the reader moving", () => {
    render(harness("a", rowsOf(20)));
    wheelUp();
    // a row above collapses: compensation moves the view up 100px, the reader did not
    (list().children[2] as HTMLElement).dataset.h = "0";
    fireResize();
    expect(list().scrollTop).toBe(1500);
    tick(CONFIRM_MS);
    (list().children[19] as HTMLElement).dataset.h = "200"; // re-armed: a growth pins
    fireResize();
    expect(list().scrollTop).toBe(1600);
  });

  it("a key or a scrollbar press that moved nothing is undone too (the press on pointerup)", () => {
    const view = render(harness("a", rowsOf(20)));
    fireEvent.keyDown(list(), { key: "ArrowUp" });
    tick(CONFIRM_MS);
    view.rerender(harness("a", rowsOf(21)));
    expect(list().scrollTop).toBe(1700);

    pointerDown(405);
    tick(CONFIRM_MS * 2); // still pressed: no check yet
    view.rerender(harness("a", rowsOf(22)));
    expect(list().scrollTop).toBe(1700);
    act(() => void window.dispatchEvent(new MouseEvent("pointerup")));
    tick(CONFIRM_MS);
    expect(list().scrollTop).toBe(1800);
  });

  it("touch: dragging the finger up does not release, dragging it down does", () => {
    const view = render(harness("a", rowsOf(20)));
    touch("touchStart", 300);
    touch("touchMove", 200);
    view.rerender(harness("a", rowsOf(21)));
    expect(list().scrollTop).toBe(1700);
    touch("touchEnd");

    touch("touchStart", 200);
    touch("touchMove", 260);
    view.rerender(harness("a", rowsOf(22)));
    expect(list().scrollTop).toBe(1700); // released: the new row does not pin
    userScroll(1640);
    touch("touchEnd");
    tick(CONFIRM_MS);
    view.rerender(harness("a", rowsOf(23)));
    expect(list().scrollTop).toBe(1640);
  });
});

describe("useStreamScroll: following again", () => {
  it("a scroll event at the very end re-arms whatever its direction", () => {
    const view = render(harness("a", rowsOf(20)));
    wheelUp();
    userScroll(1500);
    view.rerender(harness("a", rowsOf(18))); // the end moves above the view
    userScroll(1400); // clamped: an upward scroll that lands on the end
    view.rerender(harness("a", rowsOf(19)));
    expect(list().scrollTop).toBe(1500);
  });

  it("sending a message re-arms and pins, only for its own thread", () => {
    const view = render(harness("a", rowsOf(20)));
    wheelUp();
    userScroll(1000);
    view.rerender(harness("a", rowsOf(21)));
    const sent = (threadId: string) =>
      act(() => void window.dispatchEvent(new CustomEvent(MESSAGE_SENT_EVENT, { detail: { threadId } })));
    sent("b");
    expect(list().scrollTop).toBe(1000);
    sent("a");
    expect(list().scrollTop).toBe(1700);
    view.rerender(harness("a", rowsOf(22)));
    expect(list().scrollTop).toBe(1800);
  });

  it("released within 40px of the end is remembered as the end, so the next visit follows", () => {
    const view = render(harness("a", rowsOf(20)));
    wheelUp();
    userScroll(1570);
    tick();
    view.rerender(harness("b", rowsOf(5)));
    view.rerender(harness("a", rowsOf(21)));
    expect(list().scrollTop).toBe(1700);
    view.rerender(harness("a", rowsOf(22)));
    expect(list().scrollTop).toBe(1800);
  });

  it("observes a row that mounts without a rows change, and pins when it grows", async () => {
    const heights = rowsOf(20);
    const view = render(createElement(Harness, { key: "a", threadId: "a", heights }));
    await act(async () => {
      view.rerender(createElement(Harness, { key: "a", threadId: "a", heights, extra: 50 }));
    });
    const extra = screen.getByTestId("extra");
    expect(list().scrollTop).toBe(1650);
    const [observer] = observers;
    expect(observer!.targets.get(extra)).toEqual({ box: "border-box" });
    extra.dataset.h = "150";
    fireResize(extra);
    expect(list().scrollTop).toBe(1750);
  });
});

describe("useStreamScroll: debug log", () => {
  it("logs each transition with its cause only when tide.debug.scroll is 1", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      render(harness("a", rowsOf(20)));
      wheelUp();
      expect(debug).not.toHaveBeenCalled();
      cleanup();

      localStorage.setItem("tide.debug.scroll", "1");
      render(harness("b", rowsOf(20)));
      wheelUp();
      tick(CONFIRM_MS);
      expect(debug.mock.calls.map((c) => c[0])).toEqual(["[scroll] released: wheel", "[scroll] following: unmoved-release"]);
      expect(debug.mock.calls[0]![1]).toEqual({ scrollTop: 1600, toEnd: 0 });
    } finally {
      localStorage.removeItem("tide.debug.scroll");
      debug.mockRestore();
    }
  });
});
