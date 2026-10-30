import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Thread } from "@tide/contracts";
import { Rail } from "./Rail.tsx";
import { ProjectDialogHost } from "./ProjectDialogs.tsx";
import { ToastHost } from "../ui/Toast.tsx";
import { attachFakeStore, makeThread, makeTurn, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
  vi.useRealTimers();
});

const project = { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 };

function mount(threads: Thread[], turns = [makeTurn("u1", { status: "completed" })], withMessages = true) {
  const model = modelWith({ projects: { p1: project }, threads: Object.fromEntries(threads.map((t) => [t.id, t])) });
  for (const turn of turns) model.turns[turn.id] = turn;
  // threads default to having a conversation; tests for empty ones override
  for (const t of threads) model.threadMessages[t.id] = withMessages ? ["m1"] : [];
  const fake = attachFakeStore(model);
  render(
    <>
      <Rail />
      <ProjectDialogHost />
      <ToastHost />
    </>,
  );
  return fake;
}

function openMenu(title: string): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: `Actions for ${title}` }));
  return screen.getByRole("menu");
}

function choose(menu: HTMLElement, label: string | RegExp): void {
  fireEvent.click(within(menu).getByRole("menuitem", { name: label }));
}

describe("rail thread menu", () => {
  it("opens on right-click with the thread actions", () => {
    mount([makeThread("t1", { title: "Router" })]);
    fireEvent.contextMenu(screen.getByText("Router"));
    const menu = screen.getByRole("menu", { name: "Thread actions" });
    const labels = within(menu).getAllByRole("menuitem").map((n) => n.textContent);
    expect(labels).toEqual([
      "Open",
      "Rename…",
      "Pin",
      "Settle",
      "Open in terminalno session yet",
      "New child thread",
      "Fork…",
      "Snooze▸",
      "Copy thread ID",
      "Copy branchno branch",
      "Remove worktree…no worktree",
      "Archive…",
      "Delete…",
    ]);
  });

  it("renames inline: Enter saves through thread.update", () => {
    const fake = mount([makeThread("t1", { title: "Router" })]);
    choose(openMenu("Router"), "Rename…");
    const field = screen.getByLabelText("Thread title");
    fireEvent.change(field, { target: { value: "Router v2" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.update", threadId: "t1", title: "Router v2" });
    expect(screen.queryByLabelText("Thread title")).toBeNull();
  });

  it("renames inline: Esc cancels", () => {
    const fake = mount([makeThread("t1", { title: "Router" })]);
    choose(openMenu("Router"), "Rename…");
    const field = screen.getByLabelText("Thread title");
    fireEvent.change(field, { target: { value: "Nope" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(fake.dispatch).not.toHaveBeenCalled();
    expect(screen.getByText("Router")).toBeDefined();
  });

  it("pins and unpins", () => {
    const fake = mount([makeThread("t1", { title: "Router" }), makeThread("t2", { title: "Kept", pinned: true })]);
    choose(openMenu("Router"), "Pin");
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.update", threadId: "t1", pinned: true });
    choose(openMenu("Kept"), "Unpin");
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.update", threadId: "t2", pinned: false });
  });

  it("disables Fork… without a finished turn", () => {
    mount([makeThread("t1", { title: "Router" })], []);
    const item = within(openMenu("Router")).getByRole("menuitem", { name: /Fork…/ }) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    expect(item.textContent).toContain("no finished turn");
  });

  it("enables Open in terminal once the harness has a session", () => {
    mount([makeThread("t1", { title: "Router", nativeSessionId: "abc" })]);
    const item = within(openMenu("Router")).getByRole("menuitem", { name: "Open in terminal" }) as HTMLButtonElement;
    expect(item.disabled).toBe(false);
  });

  it("opens the new-thread dialog with the parent set", () => {
    mount([makeThread("t1", { title: "Router" })]);
    choose(openMenu("Router"), "New child thread");
    expect(useUi.getState().newThreadProjectId).toBe("p1");
    expect(useUi.getState().newThreadParentId).toBe("t1");
  });

  it("forks from the latest settled turn", () => {
    mount(
      [makeThread("t1", { title: "Router" })],
      [makeTurn("u1", { status: "completed", requestedAt: 1 }), makeTurn("u2", { status: "running", requestedAt: 2 })],
    );
    choose(openMenu("Router"), "Fork…");
    expect(useUi.getState().threadDialog).toEqual({ kind: "fork", threadId: "t1", turnId: "u1" });
  });

  it("snoozes for an hour from the submenu and offers Undo", async () => {
    const fake = mount([makeThread("t1", { title: "Router" })]);
    const menu = openMenu("Router");
    choose(menu, /Snooze/);
    await act(async () => {
      choose(screen.getByRole("menu"), "1 hour");
    });
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "thread.snooze", threadId: "t1" }));
    expect(screen.getByText(/^Snoozed until /)).toBeDefined();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "thread.resume", threadId: "t1" }));
  });

  it("archives (no worktree) with an Undo toast", async () => {
    const fake = mount([makeThread("t1", { title: "Router" })]);
    const menu = openMenu("Router");
    await act(async () => {
      choose(menu, "Archive…");
    });
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.archive", threadId: "t1" });
    expect(screen.getByText("Archived “Router”")).toBeDefined();
  });

  it("raises the detach dialog for Remove worktree…", () => {
    mount([makeThread("t1", { title: "Router", worktreePath: "/wt/t1" })]);
    choose(openMenu("Router"), "Remove worktree…");
    expect(useUi.getState().threadDialog).toEqual({ kind: "detach", threadId: "t1" });
  });
});

describe("rail groups", () => {
  it("lists pinned threads first in the inbox", () => {
    mount([makeThread("t1", { title: "Plain", updatedAt: 9 }), makeThread("t2", { title: "Star", pinned: true })]);
    const rows = within(screen.getByRole("list", { name: "Inbox threads" })).getAllByRole("listitem").map((n) => n.textContent ?? "");
    expect(rows[0]).toContain("Star");
    expect(rows[1]).toContain("Plain");
  });

  it("folds archived threads behind a counted toggle; snoozed stay open", () => {
    mount([
      makeThread("t1", { title: "Live" }),
      makeThread("t2", { title: "Later", snoozedUntil: Date.now() + 3_600_000 }),
      makeThread("t3", { title: "Old", archivedAt: 5 }),
    ]);
    expect(screen.getByText("Later")).toBeDefined();
    expect(screen.queryByText("Old")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Snoozed 1/ }));
    expect(screen.queryByText("Later")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Archived 1/ }));
    expect(screen.getByText("Old")).toBeDefined();
  });

  it("opens an archived thread and restores it from its menu", () => {
    const fake = mount([makeThread("t3", { title: "Old", archivedAt: 5 })]);
    fireEvent.click(screen.getByRole("button", { name: /Archived 1/ }));
    fireEvent.click(screen.getByText("Old"));
    expect(useUi.getState().selectedThreadId).toBe("t3");
    choose(openMenu("Old"), "Restore");
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.unarchive", threadId: "t3" });
  });
});

const atlas = { id: "p2", title: "Atlas", rootPath: "/src/atlas", createdAt: 1, updatedAt: 1 };

/** the chip row only exists with more than one project */
function mountProjects() {
  const fake = attachFakeStore(modelWith({ projects: { p1: project, p2: atlas } }));
  render(
    <>
      <Rail />
      <ProjectDialogHost />
      <ToastHost />
    </>,
  );
  return fake;
}

describe("rail project menu", () => {
  it("offers the project actions on right-click of its chip; archive is not painted as danger", () => {
    mountProjects();
    fireEvent.contextMenu(screen.getByText("Tide"));
    const menu = screen.getByRole("menu", { name: "Project actions" });
    expect(within(menu).getAllByRole("menuitem").map((n) => n.textContent)).toEqual([
      "New thread…",
      "New Experts session…",
      "Rename…",
      "Project icon…",
      "Linked repositories…",
      "Copy path",
      "Project settings…",
      "Archive project…",
    ]);
    expect(within(menu).getByRole("menuitem", { name: "Archive project…" }).className).not.toMatch(/danger/);
  });

  it("opens the new-thread, experts, links and settings surfaces", () => {
    mountProjects();
    choose(openMenu("Tide"), "New thread…");
    expect(useUi.getState().newThreadProjectId).toBe("p1");
    choose(openMenu("Tide"), "New Experts session…");
    expect(useUi.getState().newExpertsProjectId).toBe("p1");
    choose(openMenu("Tide"), "Linked repositories…");
    expect(useUi.getState().linksProjectId).toBe("p1");
    choose(openMenu("Tide"), "Project settings…");
    expect(useUi.getState().view).toBe("settings");
    expect(useUi.getState().settingsSection).toBe("projects");
  });

  it("renames the project through its dialog", () => {
    const fake = mountProjects();
    choose(openMenu("Tide"), "Rename…");
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Tide 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "project.update", projectId: "p1", title: "Tide 2" });
  });

  it("archives the project after confirming", () => {
    const fake = mountProjects();
    choose(openMenu("Tide"), "Archive project…");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Archive" }));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "project.archive", projectId: "p1" });
  });

  it("copies the project path", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mountProjects();
    const menu = openMenu("Tide");
    await act(async () => {
      choose(menu, "Copy path");
    });
    expect(writeText).toHaveBeenCalledWith("/src/tide");
  });
});

describe("rail merge back", () => {
  it("offers Merge back only for an unmerged branch that is not running", () => {
    mount([
      makeThread("t1", { title: "Branchy", branch: "tide/branchy" }),
      makeThread("t2", { title: "Plain" }),
      makeThread("t3", { title: "Busy", branch: "tide/busy", status: "running" }),
    ]);
    expect(within(openMenu("Branchy")).getByRole("menuitem", { name: "Merge back" })).toBeDefined();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(within(openMenu("Plain")).queryByRole("menuitem", { name: "Merge back" })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(within(openMenu("Busy")).queryByRole("menuitem", { name: "Merge back" })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Merge back Branchy" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Merge back Plain" })).toBeNull();
  });
});

describe("rail row marks", () => {
  it("puts the pin mark after the title, out of the status slot, and names the harness in the tooltip", () => {
    mount([makeThread("t2", { title: "Star", pinned: true, provider: "codex" })]);
    const title = screen.getByText("Star");
    const pin = screen.getByRole("img", { name: "pinned" });
    expect(title.compareDocumentPosition(pin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(title.closest("button")?.getAttribute("title")).toMatch(/^X · Codex/);
  });

  it("offers Delete… on live threads, and plain Delete (no Archive) for an empty one", () => {
    mount([makeThread("t1", { title: "Router" })]);
    const names = within(openMenu("Router")).getAllByRole("menuitem").map((n) => n.textContent);
    expect(names).toContain("Archive…");
    expect(names).toContain("Delete…");
    cleanup();
    mount([makeThread("t1", { title: "Blank" })], [], false);
    const empty = within(openMenu("Blank")).getAllByRole("menuitem").map((n) => n.textContent);
    expect(empty).toContain("Delete");
    expect(empty).not.toContain("Archive…");
  });

  it("deletes an empty thread at once, with a toast and no dialog", async () => {
    const fake = mount([makeThread("t1", { title: "Blank" })], [], false);
    const menu = openMenu("Blank");
    await act(async () => {
      choose(menu, "Delete");
    });
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.delete", threadId: "t1" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Deleted “Blank”")).toBeDefined();
  });

  it("asks first for an empty thread that has a child, and Clear skips it", async () => {
    const fake = mount(
      [
        makeThread("t1", { title: "Blank" }),
        makeThread("k1", { title: "Kid", parentThreadId: "t1", archivedAt: 5 }),
      ],
      [],
      false,
    );
    const menu = openMenu("Blank");
    await act(async () => {
      choose(menu, "Delete…");
    });
    expect(fake.dispatch).not.toHaveBeenCalled();
    expect(useUi.getState().threadDialog).toEqual({ kind: "delete", threadId: "t1" });
  });

  it("asks first for a thread with a conversation", () => {
    const fake = mount([makeThread("t1", { title: "Router" })]);
    choose(openMenu("Router"), "Delete…");
    expect(fake.dispatch).not.toHaveBeenCalled();
    expect(useUi.getState().threadDialog).toEqual({ kind: "delete", threadId: "t1" });
  });

  it("shows the server's reason when the delete is refused", async () => {
    const fake = mount([makeThread("t1", { title: "Blank" })], [], false);
    fake.dispatch.mockRejectedValue(new Error("another thread descends from it"));
    const menu = openMenu("Blank");
    await act(async () => {
      choose(menu, "Delete");
    });
    expect(screen.getByText("Deleting the thread failed: another thread descends from it")).toBeDefined();
  });

  it("archived threads offer Delete…, and Clear removes the empty ones", async () => {
    const fake = mount(
      [makeThread("a1", { title: "Old", archivedAt: 5 }), makeThread("a2", { title: "Blank", archivedAt: 5 })],
      [],
    );
    useUi.setState({});
    // a1 has messages (mount default); make a2 empty
    const { useModel } = await import("../../state/model.ts");
    useModel.getState().model.threadMessages["a2"] = [];
    fireEvent.click(screen.getByRole("button", { name: /Archived 2/ }));
    expect(within(openMenu("Old")).getByRole("menuitem", { name: "Delete…" })).toBeDefined();
    fireEvent.keyDown(document, { key: "Escape" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    });
    expect(fake.dispatch).toHaveBeenCalledTimes(1);
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.delete", threadId: "a2" });
    expect(screen.getByText("Deleted 1 empty thread")).toBeDefined();
  });
});
