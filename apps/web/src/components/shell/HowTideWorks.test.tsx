import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HOW_IT_WORKS_KEY, HowTideWorks, shouldShowHowItWorks, showHowTideWorks } from "./HowTideWorks.tsx";
import { modelWith } from "../../testHarness.ts";

beforeEach(() => window.localStorage.removeItem(HOW_IT_WORKS_KEY));
afterEach(cleanup);

describe("HowTideWorks", () => {
  it("shows the four points, dismisses for good, and comes back on request", () => {
    render(<HowTideWorks />);
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    fireEvent.click(screen.getByLabelText("Dismiss how Tide works"));
    expect(screen.queryByLabelText("How Tide works")).toBeNull();
    expect(window.localStorage.getItem(HOW_IT_WORKS_KEY)).toBe("1");

    cleanup();
    render(<HowTideWorks />);
    expect(screen.queryByLabelText("How Tide works")).toBeNull();

    act(() => showHowTideWorks());
    expect(screen.getByLabelText("How Tide works")).toBeDefined();
  });

  it("is due only once a project exists and until dismissed", () => {
    const project = { id: "p1", title: "T", rootPath: "/t", createdAt: 1, updatedAt: 1 };
    expect(shouldShowHowItWorks(modelWith({}))).toBe(false);
    expect(shouldShowHowItWorks(modelWith({ projects: { p1: project } }))).toBe(true);
    window.localStorage.setItem(HOW_IT_WORKS_KEY, "1");
    expect(shouldShowHowItWorks(modelWith({ projects: { p1: project } }))).toBe(false);
  });
});
