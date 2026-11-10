import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { emptyReadModel } from "@tide/contracts";
import { Board } from "./Board.tsx";
import { attachFakeStore, makeExpertsSession, modelWithExperts, resetUi } from "../../testHarness.ts";
import { useModel } from "../../state/model.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

describe("Experts board deep link before the first snapshot", () => {
  it("is loading, not gone, until the snapshot lands", () => {
    attachFakeStore(emptyReadModel());
    act(() => useModel.setState({ ready: false }));
    render(<Board sessionId="x1" />);
    expect(screen.queryByText("This experts session is gone.")).toBeNull();
    expect(screen.getByRole("status", { name: "Loading the experts session" })).toBeDefined();
    act(() => useModel.setState({ ready: true, model: modelWithExperts(makeExpertsSession("x1")) }));
    expect(screen.getByLabelText("Experts board")).toBeDefined();
  });

  it("says gone when the loaded model does not have it", () => {
    attachFakeStore(emptyReadModel());
    render(<Board sessionId="x1" />);
    expect(screen.getByText("This experts session is gone.")).toBeDefined();
  });
});
