import { afterEach, describe, expect, it } from "vitest";
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
    expect(screen.getByLabelText("merged").textContent).toBe("✓");
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
