import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { COMPOSE_EVENT, EXAMPLE_PROMPT, EmptyThread } from "./EmptyThread.tsx";
import { makeThread } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";

afterEach(cleanup);

describe("EmptyThread", () => {
  it("names the branch and explains the four pills", () => {
    render(<EmptyThread thread={makeThread("t1", { worktreePath: "/wt/t1", branch: "tide/t1" })} />);
    expect(screen.getByText("Start by describing the task")).toBeDefined();
    expect(screen.getByText("tide/t1")).toBeDefined();
    for (const term of ["Agent", "Model", "Permissions", "Build / Plan"]) expect(screen.getByText(term)).toBeDefined();
  });

  it("says the project folder when there is no worktree", () => {
    render(<EmptyThread thread={makeThread("t1")} />);
    expect(screen.getByText(/in the project folder/)).toBeDefined();
  });

  it("fills the composer through the tide:compose event", () => {
    const seen = vi.fn();
    const listener = (e: Event): void => seen((e as CustomEvent<string>).detail);
    window.addEventListener(COMPOSE_EVENT, listener);
    render(<EmptyThread thread={makeThread("t1")} />);
    fireEvent.click(screen.getByRole("button", { name: /^Try:/ }));
    window.removeEventListener(COMPOSE_EVENT, listener);
    expect(seen).toHaveBeenCalledWith(EXAMPLE_PROMPT);
  });
});

it("points at Team runs for multi-agent work", () => {
  render(<EmptyThread thread={makeThread("t1")} />);
  fireEvent.click(screen.getByRole("button", { name: "Team run" }));
  const ui = useUi.getState();
  expect(ui.newThreadTab).toBe("team");
  expect(ui.newThreadProjectId).toBe("p1");
});
