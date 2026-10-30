import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useViewport } from "./useViewport.ts";

function Probe() {
  const v = useViewport();
  return <p>{v.phone ? "phone" : "desktop"}:{v.width}</p>;
}

function mockMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    get matches() { return matches; },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.stubGlobal("matchMedia", vi.fn((q: string) => { expect(q).toBe("(max-width: 720px)"); return mql; }));
  return { set(next: boolean) { matches = next; listeners.forEach((fn) => fn()); } };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("useViewport", () => {
  it("is a phone when the 720px query matches and follows changes", () => {
    const media = mockMedia(true);
    render(<Probe />);
    expect(screen.getByText(/^phone:/)).toBeDefined();
    act(() => media.set(false));
    expect(screen.getByText(/^desktop:/)).toBeDefined();
  });
  it("falls back to desktop without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    render(<Probe />);
    expect(screen.getByText(/^desktop:/)).toBeDefined();
  });
});
