import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Rail } from "./Rail.tsx";
import { attachFakeStore, makeApproval, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";
import { RAIL_GROUPS_KEY } from "./railGroupState.ts";
import { AddProjectDialogHost } from "./AddProjectDialog.tsx";

/** the rail with the Add project dialog host App mounts beside it */
function renderRail() {
  return render(
    <>
      <Rail />
      <AddProjectDialogHost />
    </>,
  );
}

/** opens the Add project dialog from the empty state */
function openAddProject(): void {
  fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
}

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

/** the label rows of the rail's groups, top to bottom */
function groupOrder(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-rail-group]")).map((n) => n.dataset.railGroup ?? "");
}

describe("Rail", () => {
  it("is the strip plus the panel; ⌘B-collapsed it is the strip alone", () => {
    attachFakeStore(modelWith({ projects: { p1: project("p1", "Tide", "/src/tide") } }));
    render(<Rail />);
    expect(screen.getByRole("navigation", { name: "Pages" })).toBeDefined();
    expect(screen.getByRole("navigation", { name: "Navigation" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Inbox" }));
    expect(useUi.getState().railCollapsed).toBe(true);
    expect(screen.queryByRole("navigation", { name: "Navigation" })).toBeNull();
    expect(screen.getByRole("navigation", { name: "Pages" })).toBeDefined();
  });

  it("lists threads of every non-archived project in one flat list, no project tree", () => {
    attachFakeStore(
      modelWith({
        projects: {
          p1: project("p1", "Tide", "/src/tide"),
          p2: project("p2", "Atlas", "/src/atlas"),
          p3: { ...project("p3", "Gone", "/src/gone"), archivedAt: 5 },
        },
        threads: {
          t1: makeThread("t1", { projectId: "p1", title: "Refactor router", status: "running" }),
          t2: makeThread("t2", { projectId: "p2", title: "Atlas thing" }),
          t3: makeThread("t3", { projectId: "p3", title: "Hidden" }),
        },
      }),
    );
    render(<Rail />);
    const inbox = within(screen.getByRole("region", { name: "Inbox" }));
    expect(inbox.getByText("Refactor router")).toBeDefined();
    expect(inbox.getByText("Atlas thing")).toBeDefined();
    expect(screen.queryByText("Hidden")).toBeNull();
    expect(screen.getByLabelText("Running")).toBeDefined();
    // the project initial shows in All scope when there is more than one project
    expect(within(screen.getByText("Refactor router").closest("[data-rail-thread]") as HTMLElement).getByText("T")).toBeDefined();
    expect(screen.queryByText("+ thread")).toBeNull();
    expect(screen.queryByLabelText("About Experts")).toBeNull();
  });

  it("shows the add-a-repository card with no projects; its button opens the dialog that dispatches project.create", () => {
    const fake = attachFakeStore(modelWith({}));
    renderRail();
    expect(screen.getByText("Add a repository")).toBeDefined();
    expect(screen.queryByLabelText("Project root path")).toBeNull();
    openAddProject();
    expect(screen.getByRole("dialog", { name: "Add project" })).toBeDefined();
    fireEvent.change(screen.getByLabelText("Project title"), { target: { value: "  Atlas  " } });
    fireEvent.change(screen.getByLabelText("Project root path"), { target: { value: "/src/atlas" } });
    fireEvent.click(screen.getByText("Create"));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "project.create", title: "Atlas", rootPath: "/src/atlas" });
  });

  it("restores an archived project at the same path instead of creating a duplicate", () => {
    const fake = attachFakeStore(modelWith({ projects: { p9: { ...project("p9", "Atlas", "/src/atlas"), archivedAt: 3 } } }));
    renderRail();
    openAddProject();
    fireEvent.change(screen.getByLabelText("Project root path"), { target: { value: "/src/atlas" } });
    fireEvent.click(screen.getByText("Create"));
    expect(fake.dispatch.mock.calls.map((c) => (c as unknown[])[0])).toEqual([{ type: "project.unarchive", projectId: "p9" }]);
  });

  it("names the project after a typed path when the title is empty", () => {
    const fake = attachFakeStore(modelWith({}));
    renderRail();
    openAddProject();
    const path = screen.getByLabelText("Project root path");
    fireEvent.change(path, { target: { value: "/src/atlas/" } });
    fireEvent.blur(path);
    expect((screen.getByLabelText("Project title") as HTMLInputElement).value).toBe("atlas");
    fireEvent.click(screen.getByText("Create"));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "project.create", title: "atlas", rootPath: "/src/atlas/" });
  });

  it("refuses a relative root path without dispatching", () => {
    const fake = attachFakeStore(modelWith({}));
    renderRail();
    openAddProject();
    fireEvent.change(screen.getByLabelText("Project title"), { target: { value: "Atlas" } });
    fireEvent.change(screen.getByLabelText("Project root path"), { target: { value: "atlas" } });
    fireEvent.click(screen.getByText("Create"));
    expect(fake.dispatch).not.toHaveBeenCalled();
    expect(screen.getByText("Root path must be absolute")).toBeDefined();
  });

  it("New opens the thread dialog for the filtered project; the menu opens the Add project dialog", () => {
    attachFakeStore(modelWith({ projects: { p1: project("p1", "Tide", "/src/tide") } }));
    renderRail();
    // a project with no threads: the empty card offers it too
    expect(screen.getByText("No threads yet")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(useUi.getState().newThreadProjectId).toBe("p1");
    fireEvent.click(screen.getByRole("button", { name: "More new…" }));
    const menu = within(screen.getByRole("menu", { name: "New" }));
    expect(menu.getByText("Experts session")).toBeDefined();
    expect(menu.getByText("Team…")).toBeDefined();
    fireEvent.click(menu.getByText("Add project…"));
    expect(within(screen.getByRole("dialog", { name: "Add project" })).getByLabelText("Project root path")).toBeDefined();
  });

  it("asks which project a new thread is for when the scope is All", () => {
    attachFakeStore(modelWith({ projects: { p1: project("p1", "Tide", "/src/tide"), p2: project("p2", "Atlas", "/src/atlas") } }));
    render(<Rail />);
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "New" })).getByText("Atlas"));
    expect(useUi.getState().newThreadProjectId).toBe("p2");
  });

  it("groups every waiting thread, across projects, under Needs you at the top", () => {
    const model = modelWith({
      projects: { p1: project("p1", "Tide", "/src/tide"), p2: project("p2", "Atlas", "/src/atlas") },
      threads: {
        t1: makeThread("t1", { projectId: "p1", title: "Needs approval", attention: "approval", updatedAt: 5 }),
        t2: makeThread("t2", { projectId: "p2", title: "Quiet one", updatedAt: 4 }),
        t3: makeThread("t3", { projectId: "p2", title: "Plan waiting", attention: "plan", updatedAt: 3 }),
      },
    });
    model.activities["a1"] = makeApproval("a1", { threadId: "t1" });
    model.threadTimeline["t1"] = [{ kind: "activity", id: "a1" }];
    attachFakeStore(model);
    render(<Rail />);

    const group = within(screen.getByRole("region", { name: "Needs you" }));
    expect(group.getByText("2")).toBeDefined();
    expect(group.getByText("Needs approval")).toBeDefined();
    expect(group.getByText("Plan waiting")).toBeDefined();
    expect(group.queryByText("Quiet one")).toBeNull();
    // listed once: not again in the inbox
    expect(within(screen.getByRole("region", { name: "Inbox" })).queryByText("Plan waiting")).toBeNull();
    fireEvent.click(group.getByText("Plan waiting"));
    expect(useUi.getState().selectedThreadId).toBe("t3");
  });

  it("hides the Needs you group when nothing is waiting", () => {
    attachFakeStore(modelWith({ projects: { p1: project("p1", "Tide", "/src/tide") }, threads: { t1: makeThread("t1") } }));
    render(<Rail />);
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
  });
});

describe("rail groups", () => {
  const model = () =>
    modelWith({
      projects: { p1: project("p1", "Tide", "/src/tide") },
      threads: {
        n: makeThread("n", { title: "Waiting", attention: "plan" }),
        i: makeThread("i", { title: "Loose" }),
        s: makeThread("s", { title: "Later", snoozedUntil: Date.now() + 3_600_000 }),
        d: makeThread("d", { title: "Done", settledAt: 5, settleReason: "user" }),
        a: makeThread("a", { title: "Old", archivedAt: 5 }),
      },
    });

  it("orders Needs you · Inbox · Snoozed · Settled · Archived, Settled and Archived folded", () => {
    attachFakeStore(model());
    render(<Rail />);
    expect(groupOrder()).toEqual(["needs", "inbox", "snoozed", "settled", "archived"]);
    expect(screen.getByText("Later")).toBeDefined();
    expect(screen.queryByText("Done")).toBeNull();
    expect(screen.queryByText("Old")).toBeNull();
    const settled = within(screen.getByRole("region", { name: "Settled" }));
    expect(settled.getByRole("button", { name: /Settled/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("remembers a fold across mounts", () => {
    attachFakeStore(model());
    const { unmount } = render(<Rail />);
    fireEvent.click(within(screen.getByRole("region", { name: "Settled" })).getByRole("button", { name: /Settled/ }));
    expect(screen.getByText("Done")).toBeDefined();
    fireEvent.click(within(screen.getByRole("region", { name: "Inbox" })).getByRole("button", { name: /Inbox/ }));
    expect(screen.queryByText("Loose")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(RAIL_GROUPS_KEY) ?? "{}")).toEqual({ settled: false, inbox: true });
    unmount();
    render(<Rail />);
    expect(screen.getByText("Done")).toBeDefined();
    expect(screen.queryByText("Loose")).toBeNull();
  });
});
