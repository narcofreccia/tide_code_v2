import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ThreadDialogHost } from "./ThreadDialogs.tsx";
import { ThreadHeader } from "./ThreadHeader.tsx";
import { attachFakeStore, makeThread, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";
import { useToasts } from "../../state/toast.ts";
import { ToastHost } from "../ui/Toast.tsx";

afterEach(() => {
  cleanup();
  resetUi();
});

const worktreeThread = makeThread("t1", {
  title: "Refactor router",
  worktreePath: "/wt/t1",
  branch: "tide/t1",
});

function mount(thread = worktreeThread) {
  mockRpc({ "thread.terminalCommand": () => ({ cwd: "/wt/t1", command: "claude --resume abc" }) });
  const fake = attachFakeStore(modelWith({ threads: { [thread.id]: thread } }));
  useUi.setState({ selectedThreadId: thread.id, view: "thread" });
  render(
    <>
      <ThreadHeader thread={thread} />
      <ThreadDialogHost />
    </>,
  );
  return fake;
}

describe("archive dialog", () => {
  it("removes the worktree by default", () => {
    const fake = mount();
    fireEvent.click(screen.getByTitle("More actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Archive thread/ }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByText("Archive"));
    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "thread.archive",
      threadId: "t1",
      keepWorktree: false,
    });
  });

  it("keeps the worktree when asked", () => {
    const fake = mount();
    fireEvent.click(screen.getByTitle("More actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Archive thread/ }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText("Keep worktree"));
    fireEvent.click(within(dialog).getByText("Archive"));
    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "thread.archive",
      threadId: "t1",
      keepWorktree: true,
    });
  });

  it("archives directly when the thread has no worktree", () => {
    const fake = mount(makeThread("t1", { title: "No worktree" }));
    fireEvent.click(screen.getByTitle("More actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Archive thread/ }));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.archive", threadId: "t1" });
    expect(useUi.getState().threadDialog).toBeNull();
  });
});

describe("archive dialog with uncommitted work", () => {
  function mountDirty(dirty: number) {
    mockRpc({
      "thread.terminalCommand": () => ({ cwd: "/wt/t1", command: "claude --resume abc" }),
      "vcs.status": () => ({ cwd: "/wt/t1", isRepo: true, worktree: true, dirty, hasGh: false, hasRemote: false }),
    });
    const fake = attachFakeStore(modelWith({ threads: { t1: worktreeThread } }));
    render(<ThreadDialogHost />);
    act(() => useUi.getState().setThreadDialog({ kind: "archive", threadId: "t1" }));
    return fake;
  }

  it("warns and defaults to keeping the worktree when it has uncommitted changes", async () => {
    const fake = mountDirty(3);
    expect(await screen.findByText("3 uncommitted changes will be lost")).toBeDefined();
    const dialog = screen.getByRole("dialog");
    expect((within(dialog).getByLabelText("Keep worktree") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByText("Archive"));
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "thread.archive", keepWorktree: true }));
  });

  it("says nothing and removes by default on a clean worktree", async () => {
    mountDirty(0);
    await act(async () => undefined);
    expect(screen.queryByText(/uncommitted/)).toBeNull();
    const dialog = screen.getByRole("dialog");
    expect((within(dialog).getByLabelText(/Remove the worktree/) as HTMLInputElement).checked).toBe(true);
  });
});

describe("archive undo toast", () => {
  it("offers Undo, which dispatches thread.unarchive", async () => {
    const fake = attachFakeStore(modelWith({ threads: { t1: makeThread("t1", { title: "Plain" }) } }));
    render(
      <>
        <ThreadHeader thread={makeThread("t1", { title: "Plain" })} />
        <ToastHost />
      </>,
    );
    mockRpc({ "thread.terminalCommand": () => ({ cwd: "/r", command: "x" }) });
    fireEvent.click(screen.getByTitle("More actions"));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Archive thread/ }));
    });
    expect(screen.getByText("Archived “Plain”")).toBeDefined();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.unarchive", threadId: "t1" });
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("re-selects the thread on Undo when it was archived from inside it", async () => {
    attachFakeStore(modelWith({ threads: { t1: makeThread("t1", { title: "Plain" }) } }));
    useUi.setState({ selectedThreadId: "t1", view: "thread" });
    render(
      <>
        <ThreadHeader thread={makeThread("t1", { title: "Plain" })} />
        <ToastHost />
      </>,
    );
    mockRpc({ "thread.terminalCommand": () => ({ cwd: "/r", command: "x" }) });
    fireEvent.click(screen.getByTitle("More actions"));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Archive thread/ }));
    });
    expect(useUi.getState().view).toBe("mission");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    expect(useUi.getState().selectedThreadId).toBe("t1");
    expect(useUi.getState().view).toBe("thread");
  });
});

describe("detach dialog", () => {
  it("keeps the branch unless the checkbox is set", () => {
    const fake = mount();
    fireEvent.click(screen.getByTitle("More actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Remove worktree/ }));
    fireEvent.click(screen.getByText("Detach"));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "worktree.detach", threadId: "t1" });
  });

  it("passes deleteBranch for a tide/* branch", () => {
    const fake = mount();
    fireEvent.click(screen.getByTitle("More actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Remove worktree/ }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText("Detach"));
    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "worktree.detach",
      threadId: "t1",
      deleteBranch: true,
    });
  });

  it("cannot delete a branch Tide did not create", () => {
    mount(makeThread("t1", { worktreePath: "/wt/t1", branch: "feature/x" }));
    fireEvent.click(screen.getByTitle("More actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Remove worktree/ }));
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  });
});
