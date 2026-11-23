import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Thread } from "@tide/contracts";
import { Rail } from "./Rail.tsx";
import { RAIL_CHILD_FOLDS_KEY } from "./railGroupState.ts";
import { ToastHost } from "../ui/Toast.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";

const project = { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 };

afterEach(() => {
  cleanup();
  resetUi();
  window.localStorage.removeItem(RAIL_CHILD_FOLDS_KEY);
});

function mount(threads: Thread[]) {
  const model = modelWith({ projects: { p1: project }, threads: Object.fromEntries(threads.map((t) => [t.id, t])) });
  for (const t of threads) model.threadMessages[t.id] = ["m1"];
  const fake = attachFakeStore(model);
  render(
    <>
      <Rail />
      <ToastHost />
    </>,
  );
  return fake;
}

describe("rail collapsible child subthreads", () => {
  it("keeps 3 or fewer children expanded by default with no fold bar", () => {
    mount([
      makeThread("p", { title: "Parent" }),
      makeThread("c1", { title: "Child 1", delegatedBy: "p" }),
      makeThread("c2", { title: "Child 2", delegatedBy: "p" }),
      makeThread("c3", { title: "Child 3", delegatedBy: "p" }),
    ]);
    expect(screen.getByText("Child 1")).toBeDefined();
    expect(screen.getByText("Child 2")).toBeDefined();
    expect(screen.getByText("Child 3")).toBeDefined();
    expect(screen.queryByRole("button", { name: /subthread/ })).toBeNull();
  });

  it("folds more than 3 children by default, keeps running or selected children visible, and toggles cleanly", () => {
    mount([
      makeThread("p", { title: "Scaffold the app" }),
      makeThread("c1", { title: "Done 1", delegatedBy: "p" }),
      makeThread("c2", { title: "Done 2", delegatedBy: "p" }),
      makeThread("c3", { title: "Done 3", delegatedBy: "p" }),
      makeThread("c4", { title: "Running child", delegatedBy: "p", status: "running" }),
      makeThread("c5", { title: "Selected child", delegatedBy: "p" }),
    ]);
    act(() => useUi.getState().selectThread("c5"));

    // running + selected stay visible; the 3 quiet ones are folded behind the toggle
    expect(screen.getByText("Running child")).toBeDefined();
    expect(screen.getByText("Selected child")).toBeDefined();
    expect(screen.queryByText("Done 1")).toBeNull();
    expect(screen.queryByText("Done 2")).toBeNull();
    expect(screen.queryByText("Done 3")).toBeNull();

    const toggle = screen.getByRole("button", { name: /3 subthreads/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);

    expect(screen.getByText("Done 1")).toBeDefined();
    expect(screen.getByText("Done 2")).toBeDefined();
    expect(screen.getByText("Done 3")).toBeDefined();
    expect(screen.getByRole("button", { name: /Hide 5 subthreads/ }).getAttribute("aria-expanded")).toBe("true");
    expect(JSON.parse(window.localStorage.getItem(RAIL_CHILD_FOLDS_KEY) ?? "{}")).toEqual({ p: false });
  });

  it("archives finished children in one click (inheritors before owners), skips running/pinned, and offers Undo", async () => {
    const fake = mount([
      makeThread("p", { title: "Parent" }),
      makeThread("owner", { title: "Implementer", delegatedBy: "p", worktreePath: "/wt/impl", createdAt: 10 }),
      makeThread("reviewer", { title: "Reviewer", delegatedBy: "p", worktreePath: "/wt/impl", createdAt: 20 }),
      makeThread("done3", { title: "Extra", delegatedBy: "p" }),
      makeThread("busy", { title: "Busy", delegatedBy: "p", status: "running" }),
      makeThread("pin", { title: "Pinned", delegatedBy: "p", pinned: true }),
    ]);
    act(() => useUi.getState().selectThread("owner"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Archive done" }));
    });

    const archived = fake.dispatch.mock.calls.map((c) => (c as unknown[])[0]);
    expect(archived[0]).toEqual({ type: "thread.archive", threadId: "reviewer" });
    expect(archived).toContainEqual({ type: "thread.archive", threadId: "owner" });
    expect(archived).toContainEqual({ type: "thread.archive", threadId: "done3" });
    expect(archived).toHaveLength(3);
    expect(useUi.getState().selectedThreadId).toBe("p");
    expect(screen.getByText("Archived 3 finished subthreads")).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.unarchive", threadId: "reviewer" });
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.unarchive", threadId: "owner" });
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.unarchive", threadId: "done3" });
  });

  it("offers Archive finished subthreads (N) in the parent thread menu even with 1 child", async () => {
    const fake = mount([
      makeThread("p", { title: "Parent" }),
      makeThread("c1", { title: "Child 1", delegatedBy: "p" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Actions for Parent" }));
    const menu = screen.getByRole("menu");
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Archive finished subthreads (1)" }));
    });
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.archive", threadId: "c1" });
  });
});
