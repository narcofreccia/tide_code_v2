import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RailSelectionBar } from "./RailSelectionBar.tsx";
import { MergeConfirmHost } from "./MergeConfirmHost.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { clearRailSelection, useRailSelection } from "../../state/railSelection.ts";

afterEach(() => {
  cleanup();
  resetUi();
  clearRailSelection();
});

const wt = { worktreePath: "/wt" };
const threads = {
  a: makeThread("a", { ...wt, branch: "tide/a", baseBranch: "main" }),
  b: makeThread("b", { ...wt, branch: "tide/b", baseBranch: "main" }),
  r: makeThread("r", { ...wt, branch: "tide/r", status: "running" }),
  n: makeThread("n", { branch: "tide/n" }),
};

function mount(selected: string[]) {
  const fake = attachFakeStore(modelWith({ threads }));
  act(() => useRailSelection.setState({ ids: selected }));
  render(
    <>
      <RailSelectionBar />
      <MergeConfirmHost />
    </>,
  );
  return fake;
}

describe("RailSelectionBar merge back", () => {
  it("counts mergeable threads and explains the skipped ones", () => {
    mount(["a", "b", "r", "n"]);
    const button = screen.getByRole("button", { name: "Merge back (2)" });
    expect(button).toHaveProperty("disabled", false);
    expect(button.title).toBe("Skipped: 1 running · 1 without a worktree");
  });

  it("is disabled when nothing is mergeable", () => {
    mount(["r", "n"]);
    expect(screen.getByRole("button", { name: "Merge back (0)" })).toHaveProperty("disabled", true);
  });

  it("always confirms with a list, then merges in order", async () => {
    const fake = mount(["b", "a"]);
    fireEvent.click(screen.getByRole("button", { name: "Merge back (2)" }));
    expect(screen.getByText("tide/b → main")).toBeTruthy();
    expect(screen.getByText("tide/a → main")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Merge 2" }));
    await act(async () => undefined);
    expect(fake.dispatch.mock.calls.map((c) => (c[0] as { threadId: string }).threadId)).toEqual(["b", "a"]);
  });
});
