import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Project } from "@tide/contracts";
import { ProjectsSection } from "./ProjectsSection.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { useToasts } from "../../state/toast.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const tide: Project = { id: "p1", title: "Tide", rootPath: "/Users/me/dev/tide", createdAt: 1, updatedAt: 1 };
const old: Project = { id: "p2", title: "Old app", rootPath: "/Users/me/dev/old", createdAt: 1, updatedAt: 1, archivedAt: Date.now() - 3 * 86_400_000 };

function setup() {
  const fake = attachFakeStore(
    modelWith({
      projects: { p1: tide, p2: old },
      threads: { t1: makeThread("t1", { projectId: "p1" }), t2: makeThread("t2", { projectId: "p1" }), t3: makeThread("t3", { projectId: "p2" }) },
    }),
  );
  render(<ProjectsSection />);
  return fake;
}

function openMenu(title: string): void {
  fireEvent.click(screen.getByRole("button", { name: `Actions for ${title}` }));
}

describe("Settings › Projects", () => {
  it("lists live projects with path and thread count; archived ones stay folded", () => {
    setup();
    const live = screen.getByRole("region", { name: "Projects" });
    expect(within(live).getByText("Tide")).toBeDefined();
    expect(within(live).getByTitle("/Users/me/dev/tide")).toBeDefined();
    expect(within(live).getByText("2 threads")).toBeDefined();
    expect(within(live).queryByText("Old app")).toBeNull();
    expect(screen.queryByText("Old app")).toBeNull();
  });

  it("pins a project from its menu", async () => {
    const fake = setup();
    openMenu("Tide");
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Pin" })));
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "project.update", projectId: "p1", pinned: true }));
  });

  it("archives with an Undo toast that unarchives", async () => {
    const fake = setup();
    openMenu("Tide");
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Archive" })));
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "project.archive", projectId: "p1" }));
    const toast = useToasts.getState().toasts.at(-1);
    expect(toast?.text).toBe("Archived “Tide”");
    expect(toast?.action?.label).toBe("Undo");
    toast?.action?.onClick();
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "project.unarchive", projectId: "p1" }));
  });

  it("restores from the Archived group", () => {
    const fake = setup();
    fireEvent.click(screen.getByRole("button", { name: /Archived · 1/ }));
    const group = screen.getByRole("region", { name: "Archived projects" });
    expect(within(group).getByText("archived 3d ago")).toBeDefined();
    expect(within(group).getByText("1 thread")).toBeDefined();
    fireEvent.click(within(group).getByRole("button", { name: "Restore Old app" }));
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "project.unarchive", projectId: "p2" }));
  });

  it("renames inline and opens the links editor", () => {
    const fake = setup();
    openMenu("Tide");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const field = screen.getByLabelText("Rename Tide");
    fireEvent.change(field, { target: { value: "Tide v2" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "project.update", projectId: "p1", title: "Tide v2" }));
    openMenu("Tide");
    fireEvent.click(screen.getByRole("menuitem", { name: "Linked repositories…" }));
    expect(useUi.getState().linksProjectId).toBe("p1");
  });
});
