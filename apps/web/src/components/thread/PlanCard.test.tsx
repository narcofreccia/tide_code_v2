import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PlanCard } from "./PlanCard.tsx";
import { attachFakeStore, makePlan, modelWith, resetUi } from "../../testHarness.ts";
import { setProvidersForTest } from "../../state/providers.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const caps = {
  planMode: true,
  subagents: true,
  mcp: true,
  images: true,
  resume: true,
  contextUsage: true,
  openInTerminal: true,
};

describe("PlanCard", () => {
  it("implements the plan in a new thread with the chosen provider and worktree", () => {
    const fake = attachFakeStore(modelWith({}));
    setProvidersForTest([
      { kind: "claude", installed: true, loggedIn: true, models: [], caps },
      {
        kind: "codex",
        installed: true,
        loggedIn: true,
        models: [{ id: "gpt-5-codex", label: "GPT-5 Codex", default: true }],
        caps,
      },
    ]);
    render(<PlanCard plan={makePlan("pl1")} provider="claude" />);

    fireEvent.click(screen.getByText("Implement in new thread ▾"));
    fireEvent.change(screen.getByLabelText("Thread provider"), { target: { value: "codex" } });
    fireEvent.click(screen.getByText("Go"));

    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "plan.implement",
      planId: "pl1",
      provider: "codex",
      model: "gpt-5-codex",
      useWorktree: true,
    });
  });

  it("honours unchecking the worktree box", () => {
    const fake = attachFakeStore(modelWith({}));
    render(<PlanCard plan={makePlan("pl1")} provider="claude" />);
    fireEvent.click(screen.getByText("Implement in new thread ▾"));
    fireEvent.click(screen.getByLabelText("use worktree"));
    fireEvent.click(screen.getByText("Go"));
    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "plan.implement",
      planId: "pl1",
      provider: "claude",
      useWorktree: false,
    });
  });

  it("dismisses without creating anything", () => {
    const fake = attachFakeStore(modelWith({}));
    render(<PlanCard plan={makePlan("pl1")} provider="claude" />);
    fireEvent.click(screen.getByText("Dismiss"));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "plan.dismiss", planId: "pl1" });
  });

  it("links to the implementation thread once implemented", () => {
    attachFakeStore(modelWith({}));
    render(
      <PlanCard
        plan={makePlan("pl1", { status: "implemented", implementationThreadId: "t9" })}
        provider="claude"
      />,
    );
    expect(screen.getByText("open implementation thread")).toBeDefined();
    expect(screen.queryByText("Implement in new thread ▾")).toBeNull();
  });
});
