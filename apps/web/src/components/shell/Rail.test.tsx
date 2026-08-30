import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Rail } from "./Rail.tsx";
import { attachFakeStore, modelWith, resetUi } from "../../testHarness.ts";

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
    expect(screen.getByText("/src/atlas")).toBeDefined();
    expect(screen.queryByText("Gone")).toBeNull();
    expect(screen.getByText("Refactor router")).toBeDefined();
    expect(screen.getByLabelText("running")).toBeDefined();
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
});
