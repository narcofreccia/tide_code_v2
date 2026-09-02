import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Project, ProjectLink, ReadModel } from "@tide/contracts";
import { attachFakeStore, modelWith, resetUi } from "../../testHarness.ts";
import { NewThreadDialogHost, NewThreadPopover } from "./NewThreadPopover.tsx";
import { useUi } from "../../state/ui.ts";
import { choicesPayload, defaultChoices, isDefaultChoices } from "./ThreadLinkPicker.tsx";

afterEach(() => {
  cleanup();
  resetUi();
});

const links: ProjectLink[] = [
  { id: "web", path: "/src/web", label: "Web client", note: "React app", access: "write" },
  { id: "docs", path: "/src/docs", label: "Docs", access: "read" },
];

function fixture(): ReadModel {
  const project: Project = {
    id: "p1",
    title: "Tide",
    rootPath: "/src/tide",
    links,
    createdAt: 1,
    updatedAt: 1,
  };
  return modelWith({ projects: { p1: project } });
}

function openPopover(): void {
  fireEvent.click(screen.getByText("New thread"));
}

describe("thread link choices", () => {
  it("defaults to every link at its project access", () => {
    expect(defaultChoices(links)).toEqual([
      { linkId: "web", enabled: true, access: "write" },
      { linkId: "docs", enabled: true, access: "read" },
    ]);
    expect(isDefaultChoices(defaultChoices(links), links)).toBe(true);
  });

  it("drops disabled links from the payload and notices a narrowed access", () => {
    const narrowed = [
      { linkId: "web", enabled: true, access: "read" as const },
      { linkId: "docs", enabled: false, access: "read" as const },
    ];
    expect(isDefaultChoices(narrowed, links)).toBe(false);
    expect(choicesPayload(narrowed)).toEqual([{ linkId: "web", access: "read" }]);
  });
});

describe("NewThreadPopover links", () => {
  it("shows one chip per link, on by default", () => {
    attachFakeStore(fixture());
    render(<NewThreadPopover projectId="p1" />);
    openPopover();

    const picker = within(screen.getByLabelText("Linked repositories"));
    expect(picker.getByText("Web client")).toBeDefined();
    expect(picker.getByText("Docs")).toBeDefined();
    expect(picker.getAllByRole("checkbox").every((box) => (box as HTMLInputElement).checked)).toBe(true);
    // a read-only project link cannot be widened here
    expect(picker.getByLabelText("Docs access").hasAttribute("disabled")).toBe(true);
  });

  it("omits links from thread.create while the defaults are untouched", async () => {
    const fake = attachFakeStore(fixture());
    render(<NewThreadPopover projectId="p1" />);
    openPopover();
    fireEvent.click(screen.getByText("Create thread"));

    await waitFor(() => expect(fake.dispatch).toHaveBeenCalled());
    const command = fake.dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(command["type"]).toBe("thread.create");
    expect(command["links"]).toBeUndefined();
  });

  it("sends links once the user changes a chip", async () => {
    const fake = attachFakeStore(fixture());
    render(<NewThreadPopover projectId="p1" />);
    openPopover();

    const picker = within(screen.getByLabelText("Linked repositories"));
    fireEvent.click(picker.getByLabelText("Web client access"));
    fireEvent.click(picker.getAllByRole("checkbox")[1]!);
    fireEvent.click(screen.getByText("Create thread"));

    await waitFor(() => expect(fake.dispatch).toHaveBeenCalled());
    const command = fake.dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(command["links"]).toEqual([{ linkId: "web", access: "read" }]);
  });
});

describe("NewThreadDialogHost", () => {
  it("stays closed until ⌘N / the palette names a project", () => {
    attachFakeStore(fixture());
    const { container } = render(<NewThreadDialogHost />);
    expect(container.firstChild).toBeNull();
  });

  it("creates the thread and closes", async () => {
    const fake = attachFakeStore(fixture());
    render(<NewThreadDialogHost />);
    act(() => useUi.getState().setNewThreadProject("p1"));

    expect(screen.getByRole("dialog", { name: "New thread" })).toBeDefined();
    fireEvent.click(screen.getByText("Create thread"));

    await waitFor(() => expect(fake.dispatch).toHaveBeenCalled());
    expect((fake.dispatch.mock.calls[0]?.[0] as Record<string, unknown>)["type"]).toBe("thread.create");
    expect(useUi.getState().newThreadProjectId).toBeNull();
  });
});
