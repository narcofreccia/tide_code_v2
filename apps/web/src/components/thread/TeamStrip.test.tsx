import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TeamStrip } from "./TeamStrip.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const team = {
  name: "Ship",
  stages: [
    { key: "planner", role: "planner", provider: "claude" as const, worktree: "own" as const },
    { key: "implementer", role: "implementer", provider: "codex" as const, worktree: "own" as const },
    { key: "reviewer", role: "reviewer", provider: "pi" as const, worktree: "inherit" as const, inheritFrom: "implementer" },
  ],
};

describe("TeamStrip", () => {
  it("renders one chip per stage and opens a stage's thread", () => {
    const lead = makeThread("lead", { team, status: "idle" });
    attachFakeStore(
      modelWith({
        threads: {
          lead,
          impl: makeThread("impl", { delegatedBy: "lead", delegateRole: "implementer", status: "running", createdAt: 2 }),
        },
      }),
    );
    render(<TeamStrip thread={lead} />);
    expect(screen.getByRole("button", { name: "planner, Claude Code, done" })).toBeDefined();
    const impl = screen.getByRole("button", { name: "implementer, Codex, running" });
    const reviewer = screen.getByRole("button", { name: "reviewer, Pi, not started" }) as HTMLButtonElement;
    expect(reviewer.disabled).toBe(true);
    expect(reviewer.title).toContain("runs in implementer's checkout");
    fireEvent.click(impl);
    expect(useUi.getState().selectedThreadId).toBe("impl");
  });

  it("renders nothing for a thread without a team", () => {
    const t = makeThread("t");
    attachFakeStore(modelWith({ threads: { t } }));
    const { container } = render(<TeamStrip thread={t} />);
    expect(container.textContent).toBe("");
  });
});
