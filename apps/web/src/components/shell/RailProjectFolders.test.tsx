import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Rail } from "./Rail.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { useSettings } from "../../state/settings.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
  useUi.setState({ projectFilter: [] });
});

const project = (id: string, title: string, pinned?: boolean) => ({
  id, title, rootPath: `/src/${id}`, createdAt: 1, updatedAt: 1, ...(pinned === undefined ? {} : { pinned }),
});

function mount() {
  useSettings.setState({ railGroupBy: "project" });
  const fake = attachFakeStore(
    modelWith({
      projects: { p1: project("p1", "Tide"), p2: project("p2", "Atlas", true) },
      threads: {
        t1: makeThread("t1", { projectId: "p1", title: "Tide work", attention: "plan" }),
        t2: makeThread("t2", { projectId: "p2", title: "Atlas work" }),
        t3: makeThread("t3", { projectId: "p1", title: "Tide more" }),
      },
    }),
  );
  render(<Rail />);
  return fake;
}

describe("RailProjectFolders", () => {
  it("draws one folder per project, pinned first, with rows inside", () => {
    mount();
    const folders = Array.from(document.querySelectorAll("[data-rail-group^='project:']")).map((n) => n.getAttribute("data-rail-group"));
    expect(folders).toEqual(["project:p2", "project:p1"]);
    const tide = within(document.querySelector("[data-rail-group='project:p1']") as HTMLElement);
    expect(tide.getByText("Tide work")).toBeDefined();
    expect(tide.getByText("Tide more")).toBeDefined();
  });

  it("collapsing hides rows, shows the needs dot and persists the fold", () => {
    mount();
    const tide = document.querySelector("[data-rail-group='project:p1']") as HTMLElement;
    expect(tide.querySelector("[data-folder-needs]")).toBeNull();
    fireEvent.click(within(tide).getByRole("button", { expanded: true }));
    expect(screen.queryByText("Tide work")).toBeNull();
    expect(tide.querySelector("[data-folder-needs]")).not.toBeNull();
    expect(window.localStorage.getItem("tide.rail.groups")).toContain("project:p1");
  });

  it("the header menu pins and opens a new thread", async () => {
    const fake = mount();
    const tide = document.querySelector("[data-rail-group='project:p1']") as HTMLElement;
    fireEvent.contextMenu(within(tide).getByRole("button", { expanded: true }));
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Pin" })));
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "project.update", projectId: "p1", pinned: true }));
    fireEvent.contextMenu(within(tide).getByRole("button", { expanded: true }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New thread in project" }));
    expect(useUi.getState().newThreadProjectId).toBe("p1");
  });
});
