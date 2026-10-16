import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MissionControl } from "./MissionControl.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { HOW_IT_WORKS_KEY } from "../shell/HowTideWorks.tsx";

afterEach(() => {
  cleanup();
  resetUi();
});

const project = { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 };

describe("Mission Control onboarding", () => {
  it("keeps Getting started until the first thread exists, with How Tide works after the first project", () => {
    attachFakeStore(modelWith({ projects: { p1: project } }));
    render(<MissionControl />);
    expect(screen.getByLabelText("Getting started")).toBeDefined();
    expect(screen.getByLabelText("How Tide works")).toBeDefined();
    expect(screen.getByLabelText("Projects")).toBeDefined();
  });

  it("drops Getting started once a thread exists", () => {
    attachFakeStore(modelWith({ projects: { p1: project }, threads: { t1: makeThread("t1") } }));
    render(<MissionControl />);
    expect(screen.queryByLabelText("Getting started")).toBeNull();
  });

  it("hides How Tide works once dismissed", () => {
    window.localStorage.setItem(HOW_IT_WORKS_KEY, "1");
    attachFakeStore(modelWith({ projects: { p1: project }, threads: { t1: makeThread("t1") } }));
    render(<MissionControl />);
    expect(screen.queryByLabelText("How Tide works")).toBeNull();
  });
});
