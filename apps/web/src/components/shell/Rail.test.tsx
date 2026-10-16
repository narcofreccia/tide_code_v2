import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Rail } from "./Rail.tsx";
import { attachFakeStore, makeApproval, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";

const project = (id: string, title: string, rootPath: string) => ({
  id,
  title,
  rootPath,
  createdAt: 1,
  updatedAt: 1,
});

afterEach(() => {
  cleanup();
  resetUi();
});

describe("Rail", () => {
  it("renders non-archived projects with their root paths and their threads", () => {
    attachFakeStore(
      modelWith({
        projects: {
          p1: project("p1", "Tide", "/src/tide"),
          p2: project("p2", "Atlas", "/src/atlas"),
          p3: { ...project("p3", "Gone", "/src/gone"), archivedAt: 5 },
        },
        threads: {
          t1: {
            id: "t1",
            projectId: "p1",
            title: "Refactor router",
            provider: "claude",
            mode: "auto",
            interaction: "default",
            status: "running",
            createdAt: 2,
            updatedAt: 2,
          },
        },
      }),
    );
    render(<Rail />);

    expect(screen.getByText("Tide")).toBeDefined();
    // the path is a tooltip on the project row, not row text
    expect(screen.queryByText("/src/atlas")).toBeNull();
    expect(screen.getByTitle("/src/atlas")).toBeDefined();
    expect(screen.queryByText("Gone")).toBeNull();
    expect(screen.getByText("Refactor router")).toBeDefined();
    expect(screen.getByLabelText("Running")).toBeDefined();
    // projects sort by title
    expect(screen.getAllByText(/^(Tide|Atlas)$/).map((n) => n.textContent)).toEqual(["Atlas", "Tide"]);
  });

  it("dispatches project.create from the add-project form", () => {
    const fake = attachFakeStore(modelWith({}));
    render(<Rail />);

    fireEvent.click(screen.getByText("+ project"));
    fireEvent.change(screen.getByLabelText("Project title"), { target: { value: "  Atlas  " } });
    fireEvent.change(screen.getByLabelText("Project root path"), { target: { value: "/src/atlas" } });
    fireEvent.click(screen.getByText("Create"));

    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "project.create",
      title: "Atlas",
      rootPath: "/src/atlas",
    });
  });

  it("refuses a relative root path without dispatching", () => {
    const fake = attachFakeStore(modelWith({}));
    render(<Rail />);
    fireEvent.click(screen.getByText("+ project"));
    fireEvent.change(screen.getByLabelText("Project title"), { target: { value: "Atlas" } });
    fireEvent.change(screen.getByLabelText("Project root path"), { target: { value: "atlas" } });
    fireEvent.click(screen.getByText("Create"));

    expect(fake.dispatch).not.toHaveBeenCalled();
    expect(screen.getByText("Root path must be absolute")).toBeDefined();
  });

  it("dispatches thread.create from the + thread popover", () => {
    const fake = attachFakeStore(modelWith({ projects: { p1: project("p1", "Tide", "/src/tide") } }));
    render(<Rail />);
    fireEvent.click(screen.getByText("+ thread"));
    fireEvent.click(screen.getByText("Create thread"));
    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "thread.create",
      projectId: "p1",
      provider: "claude",
      title: "New thread",
      useWorktree: true,
    });
  });

  it("offers the status legend in the footer", () => {
    attachFakeStore(modelWith({}));
    render(<Rail />);
    expect(screen.getByTitle("What do the status symbols mean?")).toBeDefined();
  });

  it("groups every waiting thread, across projects, under Needs you at the top", () => {
    const base = { provider: "claude" as const, mode: "auto" as const, interaction: "default" as const, createdAt: 2 };
    const model = modelWith({
      projects: { p1: project("p1", "Tide", "/src/tide"), p2: project("p2", "Atlas", "/src/atlas") },
      threads: {
        t1: { ...base, id: "t1", projectId: "p1", title: "Needs approval", status: "idle", attention: "approval", updatedAt: 5 },
        t2: { ...base, id: "t2", projectId: "p2", title: "Quiet one", status: "idle", updatedAt: 4 },
        t3: { ...base, id: "t3", projectId: "p2", title: "Plan waiting", status: "idle", attention: "plan", updatedAt: 3 },
      },
    });
    model.activities["a1"] = makeApproval("a1", { threadId: "t1" });
    model.threadTimeline["t1"] = [{ kind: "activity", id: "a1" }];
    attachFakeStore(model);
    render(<Rail />);

    const group = within(screen.getByRole("region", { name: "Needs you" }));
    expect(group.getByRole("heading", { name: /Needs you/ })).toBeDefined();
    expect(group.getByText("· 2")).toBeDefined();
    expect(group.getByText("Needs approval")).toBeDefined();
    expect(group.getByText("Plan waiting")).toBeDefined();
    expect(group.queryByText("Quiet one")).toBeNull();
    fireEvent.click(group.getByText("Plan waiting"));
    expect(useUi.getState().selectedThreadId).toBe("t3");
  });

  it("hides the Needs you group when nothing is waiting", () => {
    attachFakeStore(modelWith({ projects: { p1: project("p1", "Tide", "/src/tide") } }));
    render(<Rail />);
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
  });

  it("shows project badges only when non-zero and collapses with the chevron", () => {
    const base = { provider: "claude" as const, mode: "auto" as const, interaction: "default" as const, createdAt: 2 };
    attachFakeStore(
      modelWith({
        projects: { p1: project("p1", "Tide", "/src/tide"), p2: project("p2", "Atlas", "/src/atlas") },
        threads: {
          t1: { ...base, id: "t1", projectId: "p1", title: "Busy", status: "running", updatedAt: 5 },
        },
      }),
    );
    render(<Rail />);
    expect(screen.getByText("● 1")).toBeDefined();
    expect(screen.queryByText(/◐ \d/)).toBeNull();
    expect(screen.getByText("Busy")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Tide" }));
    expect(screen.queryByText("Busy")).toBeNull();
    expect(useUi.getState().selectedProjectId).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand Tide" }));
    expect(screen.getByText("Busy")).toBeDefined();
  });
});
