import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Thread } from "@tide/contracts";
import { ProjectTree } from "./ProjectTree.tsx";
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

function mount(threads: Thread[], turns = [makeTurn("u1", { status: "completed" })]) {
  const model = modelWith({ projects: { p1: project }, threads: Object.fromEntries(threads.map((t) => [t.id, t])) });
  for (const turn of turns) model.turns[turn.id] = turn;
  const fake = attachFakeStore(model);
  render(
    <>
      <ProjectTree />
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
      "Open in terminalno session yet",
      "New child thread",
      "Fork…",
      "Snooze▸",
      "Copy thread ID",
      "Copy branchno branch",
      "Remove worktree…no worktree",
      "Archive…",
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
  it("lists pinned threads first under Pinned", () => {
    mount([makeThread("t1", { title: "Plain", updatedAt: 9 }), makeThread("t2", { title: "Star", pinned: true })]);
    expect(within(screen.getByLabelText("Pinned threads")).getByText("Star")).toBeDefined();
  });

  it("labels the remaining threads only when a Pinned group exists", () => {
    mount([makeThread("t1", { title: "Plain", updatedAt: 9 }), makeThread("t2", { title: "Star", pinned: true })]);
    expect(screen.getByText("Threads")).toBeDefined();
    expect(within(screen.getByLabelText("Other threads")).getByText("Plain")).toBeDefined();
    cleanup();
    mount([makeThread("t1", { title: "Plain" })]);
    expect(screen.queryByText("Threads")).toBeNull();
  });

  it("collapses snoozed and archived threads behind counted toggles", () => {
    mount([
      makeThread("t1", { title: "Live" }),
      makeThread("t2", { title: "Later", snoozedUntil: Date.now() + 3_600_000 }),
      makeThread("t3", { title: "Old", archivedAt: 5 }),
    ]);
    expect(screen.queryByText("Later")).toBeNull();
    expect(screen.queryByText("Old")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Snoozed · 1/ }));
    expect(screen.getByText("Later")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Archived · 1/ }));
    expect(screen.getByText("Old")).toBeDefined();
  });

  it("opens an archived thread and restores it from its menu", () => {
    const fake = mount([makeThread("t3", { title: "Old", archivedAt: 5 })]);
    fireEvent.click(screen.getByRole("button", { name: /Archived · 1/ }));
    fireEvent.click(screen.getByText("Old"));
    expect(useUi.getState().selectedThreadId).toBe("t3");
    choose(openMenu("Old"), "Restore");
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.unarchive", threadId: "t3" });
  });
});

describe("rail project menu", () => {
  it("offers the project actions", () => {
    mount([]);
    fireEvent.contextMenu(screen.getByText("Tide"));
    const menu = screen.getByRole("menu", { name: "Project actions" });
    expect(within(menu).getAllByRole("menuitem").map((n) => n.textContent)).toEqual([
      "New thread…",
      "New Experts session…",
      "Rename…",
      "Linked repositories…",
      "Copy path",
      "Archive project…",
    ]);
  });

  it("opens the new-thread, experts and links dialogs", () => {
    mount([]);
    choose(openMenu("Tide"), "New thread…");
    expect(useUi.getState().newThreadProjectId).toBe("p1");
    choose(openMenu("Tide"), "New Experts session…");
    expect(useUi.getState().newExpertsProjectId).toBe("p1");
    choose(openMenu("Tide"), "Linked repositories…");
    expect(useUi.getState().linksProjectId).toBe("p1");
  });

  it("renames the project through its dialog", () => {
    const fake = mount([]);
    choose(openMenu("Tide"), "Rename…");
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Tide 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "project.update", projectId: "p1", title: "Tide 2" });
  });

  it("archives the project after confirming", () => {
    const fake = mount([]);
    choose(openMenu("Tide"), "Archive project…");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Archive" }));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "project.archive", projectId: "p1" });
  });

  it("copies the project path", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mount([]);
    const menu = openMenu("Tide");
    await act(async () => {
      choose(menu, "Copy path");
    });
    expect(writeText).toHaveBeenCalledWith("/src/tide");
  });
});

describe("rail Experts explainer", () => {
  it("sits below the threads and the + thread / + Experts links", () => {
    mount([makeThread("t1", { title: "Router" })]);
    const explainer = screen.getByLabelText("About Experts");
    const row = screen.getByText("Router");
    const links = screen.getByRole("button", { name: "+ Experts" });
    const follows = (a: Node, b: Node): boolean => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(row, explainer)).toBe(true);
    expect(follows(links, explainer)).toBe(true);
  });
});

describe("rail row marks", () => {
  it("puts the pin mark after the title, out of the status slot, and names the harness in the tooltip", () => {
    mount([makeThread("t2", { title: "Star", pinned: true, provider: "codex" })]);
    const title = screen.getByText("Star");
    const pin = screen.getByRole("img", { name: "pinned" });
    expect(title.compareDocumentPosition(pin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pin.textContent).not.toContain("⊙");
    expect(title.closest("button")?.getAttribute("title")).toMatch(/^X · Codex/);
  });
});
