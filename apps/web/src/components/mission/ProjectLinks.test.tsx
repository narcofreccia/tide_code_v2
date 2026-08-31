import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Project, ProjectLink, ReadModel } from "@tide/contracts";
import { attachFakeStore, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";
import { ProjectCard } from "./ProjectCard.tsx";
import { ProjectLinks, ProjectLinksDialogHost } from "./ProjectLinks.tsx";

afterEach(() => {
  cleanup();
  resetUi();
});

const link = (id: string, patch: Partial<ProjectLink> = {}): ProjectLink => ({
  id,
  path: `/src/${id}`,
  label: id,
  access: "write",
  ...patch,
});

function fixture(links?: ProjectLink[]): ReadModel {
  const project: Project = {
    id: "p1",
    title: "Tide",
    rootPath: "/src/tide",
    createdAt: 1,
    updatedAt: 1,
    ...(links === undefined ? {} : { links }),
  };
  return modelWith({ projects: { p1: project } });
}

describe("ProjectLinks", () => {
  it("explains the section and lists each link with its path, note and access", () => {
    attachFakeStore(fixture([link("web", { label: "Web client", note: "React app", access: "read" })]));
    render(<ProjectLinks projectId="p1" />);

    expect(screen.getByText(/Threads in this project can read/)).toBeDefined();
    expect(screen.getByText("Web client")).toBeDefined();
    expect(screen.getByText("/src/web")).toBeDefined();
    expect(screen.getByText("React app")).toBeDefined();
    expect(screen.getByText("ro")).toBeDefined();
  });

  it("dispatches project.link.add with the typed path, label, note and access", async () => {
    const fake = attachFakeStore(fixture());
    render(<ProjectLinks projectId="p1" />);
    expect(screen.getByText("No linked repositories yet.")).toBeDefined();

    fireEvent.click(screen.getByText("Add repository…"));
    fireEvent.change(screen.getByLabelText("Repository path"), { target: { value: "/src/web" } });
    fireEvent.change(screen.getByLabelText("Link label"), { target: { value: "Web client" } });
    fireEvent.change(screen.getByLabelText("Link note"), { target: { value: "React app" } });
    fireEvent.click(screen.getByText("Read only"));
    fireEvent.click(screen.getByText("Link repository"));

    await waitFor(() =>
      expect(fake.dispatch).toHaveBeenCalledWith({
        type: "project.link.add",
        projectId: "p1",
        path: "/src/web",
        label: "Web client",
        note: "React app",
        access: "read",
      }),
    );
  });

  it("refuses a relative path", () => {
    const fake = attachFakeStore(fixture());
    render(<ProjectLinks projectId="p1" />);
    fireEvent.click(screen.getByText("Add repository…"));
    fireEvent.change(screen.getByLabelText("Repository path"), { target: { value: "web" } });
    fireEvent.click(screen.getByText("Link repository"));

    expect(screen.getByText("Path must be absolute")).toBeDefined();
    expect(fake.dispatch).not.toHaveBeenCalled();
  });

  it("edits a link in place without touching its path", async () => {
    const fake = attachFakeStore(fixture([link("web", { label: "Web client" })]));
    render(<ProjectLinks projectId="p1" />);

    fireEvent.click(screen.getByLabelText("Edit Web client"));
    expect(screen.queryByLabelText("Repository path")).toBeNull();
    fireEvent.change(screen.getByLabelText("Link label"), { target: { value: "Client" } });
    fireEvent.click(screen.getByText("Read only"));
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() =>
      expect(fake.dispatch).toHaveBeenCalledWith({
        type: "project.link.update",
        projectId: "p1",
        linkId: "web",
        label: "Client",
        note: "",
        access: "read",
      }),
    );
  });

  it("confirms before removing a link", () => {
    const fake = attachFakeStore(fixture([link("web", { label: "Web client" })]));
    render(<ProjectLinks projectId="p1" />);

    fireEvent.click(screen.getByLabelText("Remove Web client"));
    expect(screen.getByRole("dialog", { name: /Unlink/ })).toBeDefined();
    expect(fake.dispatch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Remove link"));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "project.link.remove", projectId: "p1", linkId: "web" });
  });
});

describe("links affordance", () => {
  it("opens the links dialog from the project card", () => {
    attachFakeStore(fixture([link("web"), link("docs")]));
    render(
      <>
        <ProjectCard project={fixture([link("web"), link("docs")]).projects["p1"]!} />
        <ProjectLinksDialogHost />
      </>,
    );

    fireEvent.click(screen.getByText("Links · 2"));
    expect(useUi.getState().linksProjectId).toBe("p1");
    expect(screen.getByRole("dialog", { name: /Linked repositories/ })).toBeDefined();
  });

  it("invites the first link when the project has none", () => {
    attachFakeStore(fixture());
    render(<ProjectCard project={fixture().projects["p1"]!} />);
    expect(screen.getByText("Link a repo")).toBeDefined();
  });
});
