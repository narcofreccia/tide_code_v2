import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ThreadDialogHost } from "./ThreadDialogs.tsx";
import { ThreadHeader } from "./ThreadHeader.tsx";
import { attachFakeStore, makeThread, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";

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
    fireEvent.click(screen.getByText("Archive"));
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
    fireEvent.click(screen.getByText("Archive"));
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
    fireEvent.click(screen.getByText("Archive"));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.archive", threadId: "t1" });
    expect(useUi.getState().threadDialog).toBeNull();
  });
});

describe("detach dialog", () => {
  it("keeps the branch unless the checkbox is set", () => {
    const fake = mount();
    fireEvent.click(screen.getByTitle("More actions"));
    fireEvent.click(screen.getByText("Detach worktree…"));
    fireEvent.click(screen.getByText("Detach"));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "worktree.detach", threadId: "t1" });
  });

  it("passes deleteBranch for a tide/* branch", () => {
    const fake = mount();
    fireEvent.click(screen.getByTitle("More actions"));
    fireEvent.click(screen.getByText("Detach worktree…"));
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
    fireEvent.click(screen.getByText("Detach worktree…"));
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  });
});
