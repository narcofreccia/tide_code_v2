import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeVisibleAnimation } from "./visibleAnimation.ts";

type Callback = (entries: Array<{ target: Element; isIntersecting: boolean }>) => void;

/** One fake observer per construction; the test drives its callback by hand. */
class FakeObserver {
  static instances: FakeObserver[] = [];
  readonly observed = new Set<Element>();
  disconnected = false;
  private readonly callback: Callback;
  constructor(callback: Callback) {
    this.callback = callback;
    FakeObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.add(el);
  }
  unobserve(el: Element): void {
    this.observed.delete(el);
  }
  disconnect(): void {
    this.disconnected = true;
    this.observed.clear();
  }
  report(target: Element, isIntersecting: boolean): void {
    this.callback([{ target, isIntersecting }]);
  }
}

let reduced = false;
let hidden = false;

const state = (el: HTMLElement): string => el.style.getPropertyValue("--visible-animation-state");

beforeEach(() => {
  FakeObserver.instances = [];
  reduced = false;
  hidden = false;
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced, media: query }));
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => (hidden ? "hidden" : "visible"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("observeVisibleAnimation", () => {
  it("starts paused and runs once the element is on screen", () => {
    const el = document.createElement("span");
    const stop = observeVisibleAnimation(el);
    expect(state(el)).toBe("paused");
    FakeObserver.instances[0]!.report(el, true);
    expect(state(el)).toBe("running");
    FakeObserver.instances[0]!.report(el, false);
    expect(state(el)).toBe("paused");
    stop();
  });

  it("shares one observer and drops it with the last element", () => {
    const a = document.createElement("span");
    const b = document.createElement("span");
    const stopA = observeVisibleAnimation(a);
    const stopB = observeVisibleAnimation(b);
    expect(FakeObserver.instances).toHaveLength(1);
    const io = FakeObserver.instances[0]!;
    expect([...io.observed]).toEqual([a, b]);
    stopA();
    expect(io.disconnected).toBe(false);
    stopB();
    expect(io.disconnected).toBe(true);
    // a later element gets a fresh observer
    const stopC = observeVisibleAnimation(document.createElement("span"));
    expect(FakeObserver.instances).toHaveLength(2);
    stopC();
  });

  it("pauses while the tab is hidden", () => {
    const el = document.createElement("span");
    const stop = observeVisibleAnimation(el);
    FakeObserver.instances[0]!.report(el, true);
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(state(el)).toBe("paused");
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(state(el)).toBe("running");
    stop();
  });

  it("stays paused under reduced motion", () => {
    reduced = true;
    const el = document.createElement("span");
    const stop = observeVisibleAnimation(el);
    FakeObserver.instances[0]!.report(el, true);
    expect(state(el)).toBe("paused");
    stop();
  });

  it("ignores reports for elements it already released", () => {
    const el = document.createElement("span");
    const keep = observeVisibleAnimation(document.createElement("span"));
    const stop = observeVisibleAnimation(el);
    const io = FakeObserver.instances[0]!;
    stop();
    io.report(el, true);
    expect(state(el)).toBe("paused");
    keep();
  });

  it("treats a browser without IntersectionObserver as on screen", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const el = document.createElement("span");
    const stop = observeVisibleAnimation(el);
    expect(state(el)).toBe("running");
    stop();
  });

  it("accepts the null a ref callback can receive", () => {
    expect(() => observeVisibleAnimation(null)()).not.toThrow();
  });
});
