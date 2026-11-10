import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { emptyReadModel } from "@tide/contracts";
import { MissionControl } from "./MissionControl.tsx";
import { AllThreads } from "./AllThreads.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { useModel } from "../../state/model.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const project = { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 };

/** Attaches the model as "not loaded yet": the first snapshot has not landed. */
function attachLoading(model = emptyReadModel()): void {
  attachFakeStore(model);
  useModel.setState({ ready: false });
}

describe("Mission Control before the first snapshot", () => {
  it("shows a skeleton, not the first-run checklist, then the checklist once the server says it is empty", () => {
    attachLoading();
    render(<MissionControl />);
    expect(screen.getByRole("status", { name: "Loading Mission Control" })).toBeDefined();
    expect(screen.queryByLabelText("Getting started")).toBeNull();
    act(() => useModel.setState({ ready: true }));
    expect(screen.queryByRole("status", { name: "Loading Mission Control" })).toBeNull();
    expect(screen.getByLabelText("Getting started")).toBeDefined();
  });

  it("shows a skeleton, then the projects when the snapshot carries them", () => {
    attachLoading();
    render(<MissionControl />);
    expect(screen.queryByLabelText("Projects")).toBeNull();
    act(() => useModel.setState({ ready: true, model: modelWith({ projects: { p1: project }, threads: { t1: makeThread("t1") } }) }));
    expect(screen.queryByRole("status", { name: "Loading Mission Control" })).toBeNull();
    expect(screen.getByLabelText("Projects")).toBeDefined();
  });
});

describe("All threads before the first snapshot", () => {
  it("does not say there are no threads until it knows", () => {
    attachLoading();
    render(<AllThreads projectId="p1" />);
    expect(screen.queryByText("No threads yet.")).toBeNull();
    expect(screen.getByRole("status", { name: "Loading threads" })).toBeDefined();
    act(() => useModel.setState({ ready: true }));
    expect(screen.getByText("No threads yet.")).toBeDefined();
  });
});
