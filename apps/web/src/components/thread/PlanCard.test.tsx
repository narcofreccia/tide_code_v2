import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PlanCard } from "./PlanCard.tsx";
import { attachFakeStore, chooseOption, makePlan, modelWith, resetUi } from "../../testHarness.ts";
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
  it("implements the plan in this thread by default", () => {
    const fake = attachFakeStore(modelWith({}));
    render(<PlanCard plan={makePlan("pl1")} provider="claude" />);
    fireEvent.click(screen.getByRole("button", { name: "Implement" }));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "plan.implement", planId: "pl1", target: "here" });
  });

  it("offers a new thread from the chevron, explaining the difference while open", () => {
    attachFakeStore(modelWith({}));
    render(<PlanCard plan={makePlan("pl1")} provider="claude" />);
    const chevron = screen.getByRole("button", { name: "Implement in a new thread" });
    expect(chevron.getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.queryByText(/Same thread keeps the planning context/)).toBeNull();
    fireEvent.click(chevron);
    expect(screen.getByText("In a new thread")).toBeDefined();
    expect(screen.getByText(/Same thread keeps the planning context/)).toBeDefined();
  });

  it("implements the plan in a new thread with the chosen provider and worktree", () => {
    const fake = attachFakeStore(modelWith({}));
    setProvidersForTest([
      { id: "claude", kind: "claude", label: "Claude Code", installed: true, loggedIn: true, models: [], caps },
      {
        id: "codex", kind: "codex", label: "Codex",
        installed: true,
        loggedIn: true,
        models: [{ id: "gpt-5-codex", label: "GPT-5 Codex", default: true }],
        caps,
      },
    ]);
    render(<PlanCard plan={makePlan("pl1")} provider="claude" />);

    fireEvent.click(screen.getByRole("button", { name: "Implement in a new thread" }));
    chooseOption("Thread provider", "Codex");
    fireEvent.click(screen.getByText("Go"));

    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "plan.implement",
      planId: "pl1",
      target: "new",
      provider: "codex",
      model: "gpt-5-codex",
      useWorktree: true,
    });
  });

  it("honours unchecking the worktree box", () => {
    const fake = attachFakeStore(modelWith({}));
    render(<PlanCard plan={makePlan("pl1")} provider="claude" />);
    fireEvent.click(screen.getByRole("button", { name: "Implement in a new thread" }));
    fireEvent.click(screen.getByLabelText("use worktree"));
    fireEvent.click(screen.getByText("Go"));
    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "plan.implement",
      planId: "pl1",
      target: "new",
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
    expect(screen.queryByRole("button", { name: "Implement" })).toBeNull();
  });

  it("says implemented here, with no link, when it ran in the planning thread", () => {
    attachFakeStore(modelWith({}));
    render(
      <PlanCard
        plan={makePlan("pl1", { status: "implemented", implementationThreadId: "t1" })}
        provider="claude"
      />,
    );
    expect(screen.getByText("implemented here")).toBeDefined();
    expect(screen.queryByText("open implementation thread")).toBeNull();
  });
});
