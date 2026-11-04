import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHORD_WINDOW_MS, createChordMatcher } from "./chords.ts";

const key = (k: string, init: KeyboardEventInit = {}, target?: Element) => {
  const event = new KeyboardEvent("keydown", { key: k, cancelable: true, bubbles: true, ...init });
  if (target) Object.defineProperty(event, "target", { value: target });
  return event;
};

describe("chord matcher", () => {
  const run = vi.fn<() => boolean | void>();
  const matcher = createChordMatcher(() => [
    { id: "goto.mission", binding: "g m", run },
    { id: "plain", binding: "mod+k", run: () => undefined },
  ]);

  beforeEach(() => {
    vi.useFakeTimers();
    run.mockReset();
    matcher.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
    (document.activeElement as HTMLElement | null)?.blur();
  });

  it("arms on the first key, completes on the second", () => {
    const first = key("g");
    expect(matcher.handle(first)).toBe(true);
    expect(first.defaultPrevented).toBe(true);
    expect(matcher.armed?.prefix).toBe("g");
    const second = key("m");
    expect(matcher.handle(second)).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(matcher.armed).toBeNull();
  });

  it("expires after the window", () => {
    matcher.handle(key("g"));
    vi.advanceTimersByTime(CHORD_WINDOW_MS + 1);
    expect(matcher.armed).toBeNull();
    const second = key("m");
    expect(matcher.handle(second)).toBe(false);
    expect(second.defaultPrevented).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("a non-matching second key cancels and passes through", () => {
    matcher.handle(key("g"));
    const other = key("x");
    expect(matcher.handle(other)).toBe(false);
    expect(other.defaultPrevented).toBe(false);
    expect(matcher.armed).toBeNull();
  });

  it("ignores typing targets", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    const event = key("g", {}, input);
    expect(matcher.handle(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(matcher.armed).toBeNull();
    input.remove();
  });

  it("ignores keys with modifiers and bare modifier presses", () => {
    expect(matcher.handle(key("g", { metaKey: true }))).toBe(false);
    expect(matcher.handle(key("g", { ctrlKey: true }))).toBe(false);
    expect(matcher.armed).toBeNull();
    matcher.handle(key("g"));
    expect(matcher.handle(key("Shift", { shiftKey: true }))).toBe(false);
    expect(matcher.armed?.prefix).toBe("g");
  });

  it("does not arm for unrelated keys", () => {
    expect(matcher.handle(key("j"))).toBe(false);
    expect(matcher.armed).toBeNull();
  });

  it("falls through when the action does not apply", () => {
    run.mockReturnValue(false);
    matcher.handle(key("g"));
    expect(matcher.handle(key("m"))).toBe(false);
  });
});
