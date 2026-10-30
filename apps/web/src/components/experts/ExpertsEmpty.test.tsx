import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Board } from "./Board.tsx";
import { ExpertsEmpty } from "./ExpertsEmpty.tsx";
import { attachFakeStore, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const PROJECTS = {
  p1: { id: "p1", title: "App", rootPath: "/src/app", createdAt: 1, updatedAt: 1 },
  p2: { id: "p2", title: "Docs", rootPath: "/src/docs", createdAt: 1, updatedAt: 1 },
};

describe("Experts empty state", () => {
  it("explains Experts and starts a session in the given project", () => {
    attachFakeStore(modelWith({ projects: PROJECTS }));
    render(<ExpertsEmpty projectId="p2" />);
    expect(screen.getByText("Several agents explore a question, discuss, and propose one plan.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Start an Experts session" }));
    expect(useUi.getState().newExpertsProjectId).toBe("p2");
  });

  it("stands in for a board whose session is gone, targeting the project in view", () => {
    attachFakeStore(modelWith({ projects: PROJECTS }));
    useUi.setState({ selectedProjectId: "p1" });
    render(<Board sessionId="missing" />);
    expect(screen.getByText("This experts session is gone.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Start an Experts session" }));
    expect(useUi.getState().newExpertsProjectId).toBe("p1");
  });

  it("is disabled with no project to start in", () => {
    attachFakeStore(modelWith({}));
    render(<ExpertsEmpty />);
    expect((screen.getByRole("button", { name: "Start an Experts session" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
