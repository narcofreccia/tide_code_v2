import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { makeThread } from "../../testHarness.ts";
import { StatusGlyph, ThreadGlyph } from "./StatusGlyph.tsx";
import { MergeGlyph } from "./VcsBadges.tsx";

afterEach(cleanup);

describe("StatusGlyph merged", () => {
  it("shows ✓ for an idle merged thread", () => {
    render(<StatusGlyph status="idle" merged />);
    expect(screen.getByRole("img").textContent).toBe("✓");
    expect(screen.getByLabelText("merged")).toBeDefined();
  });

  it("lets running and needs-you win over merged", () => {
    render(
      <>
        <StatusGlyph status="running" merged />
        <StatusGlyph status="idle" attention="approval" merged />
      </>,
    );
    expect(screen.getAllByRole("img").map((n) => n.textContent)).toEqual(["●", "◐"]);
  });

  it("ThreadGlyph reads merged from a merged PR too", () => {
    render(<ThreadGlyph thread={makeThread("t1", { pr: { url: "u", number: 1, state: "merged", updatedAt: 1 } })} />);
    expect(screen.getByLabelText("Merged").textContent).toBe("✓");
  });
});

describe("MergeGlyph", () => {
  it("covers merging, error and a local merge, and stays quiet when the PR already says merged", () => {
    const { rerender, container } = render(
      <MergeGlyph thread={makeThread("t1", { merge: { status: "merging", strategy: "squash", at: 1 } })} />,
    );
    expect(container.textContent).toBe("⟳ merging");
    rerender(<MergeGlyph thread={makeThread("t1", { merge: { status: "error", strategy: "squash", at: 1 } })} />);
    expect(container.textContent).toBe("✕ merge failed");
    rerender(<MergeGlyph thread={makeThread("t1", { mergedAt: 1 })} />);
    expect(container.textContent).toBe("✓ merged");
    rerender(
      <MergeGlyph thread={makeThread("t1", { mergedAt: 1, pr: { url: "u", number: 1, state: "merged", updatedAt: 1 } })} />,
    );
    expect(container.textContent).toBe("");
  });
});

describe("StatusGlyph running pulse", () => {
  it("gives a running glyph the stepped pulse; other states stay still", () => {
    render(
      <>
        <StatusGlyph status="running" />
        <StatusGlyph status="idle" />
      </>,
    );
    const [run, idle] = screen.getAllByRole("img");
    expect(run?.className).toContain("running");
    expect(run?.hasAttribute("data-pulse")).toBe(true);
    expect(idle?.hasAttribute("data-pulse")).toBe(false);
  });

  it("restarts every running glyph's animation when one loops", () => {
    const animations = [{ currentTime: 400 }, { currentTime: 900 }];
    const proto = HTMLElement.prototype as unknown as { getAnimations?: (() => unknown[]) | undefined };
    const original = proto.getAnimations;
    let i = 0;
    proto.getAnimations = function () {
      return [animations[i++ % 2]];
    };
    try {
      render(
        <>
          <StatusGlyph status="running" />
          <StatusGlyph status="running" />
        </>,
      );
      const first = screen.getAllByRole("img")[0] as HTMLElement;
      first.dispatchEvent(new Event("animationiteration", { bubbles: true }));
      expect(animations.map((a) => a.currentTime)).toEqual([0, 0]);
    } finally {
      proto.getAnimations = original;
    }
  });

  it("is paused under reduced motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query }));
    try {
      render(<StatusGlyph status="running" />);
      expect(screen.getByRole("img").style.getPropertyValue("--visible-animation-state")).toBe("paused");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
