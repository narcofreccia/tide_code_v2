import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MergeConfirmHost } from "./MergeConfirmHost.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

describe("MergeConfirmHost", () => {
  it("renders the single-thread body", () => {
    attachFakeStore(modelWith({ threads: { a: makeThread("a", { branch: "tide/a" }) } }));
    render(<MergeConfirmHost />);
    act(() => useUi.getState().setMergeConfirm("a"));
    expect(screen.getByText("tide/a")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Merge back" })).toBeTruthy();
  });

  it("renders a list body for several threads", () => {
    attachFakeStore(
      modelWith({
        threads: {
          a: makeThread("a", { branch: "tide/a", baseBranch: "main" }),
          b: makeThread("b", { branch: "tide/b", baseBranch: "dev" }),
        },
      }),
    );
    render(<MergeConfirmHost />);
    act(() => useUi.getState().setMergeConfirmMany(["a", "b"]));
    expect(screen.getByText(/Merge 2 branches into their bases as one squashed commit/)).toBeTruthy();
    expect(screen.getByText("tide/a → main")).toBeTruthy();
    expect(screen.getByText("tide/b → dev")).toBeTruthy();
  });
});
