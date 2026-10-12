import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DiffResult, MergeState as Merge } from "@tide/contracts";
import { useUi } from "../../state/ui.ts";
import { threadTabs } from "../../state/workbench.ts";
import {
  attachFakeStore,
  makeMessage,
  makeThread,
  makeTurn,
  mockRpc,
  modelWithTurns,
  resetUi,
} from "../../testHarness.ts";
import { ChangesTab } from "./ChangesTab.tsx";

vi.mock("./monaco/MonacoDiff.tsx", () => ({
  MonacoDiff: () => <div data-testid="monaco" />,
}));

const checkpoint = { before: "s0", after: "s1", stats: { files: 1, additions: 3, deletions: 1 } };

function diff(): DiffResult {
  return {
    base: "s0",
    head: "WORKTREE",
    files: [{ path: "src/a.ts", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b\n" }],
  };
}

const worktree = { worktreePath: "/wt/t1", branch: "tide/t1", baseBranch: "main" };

async function mount(patch: Parameters<typeof makeThread>[1] = {}, running = false) {
  const thread = makeThread("t1", { latestTurnId: "u1", ...worktree, ...patch });
  const model = modelWithTurns(
    thread,
    [makeTurn("u1", { checkpoint, ...(running ? { status: "running" as const } : {}) })],
    [makeMessage("m1", { text: "prompt" })],
  );
  const fake = attachFakeStore(model);
  useUi.setState({ selectedThreadId: "t1", view: "thread" });
  mockRpc({ "vcs.turnDiff": () => diff(), "vcs.fileAt": () => ({ content: "x", binary: false, missing: false }) });
  render(<ChangesTab />);
  await waitFor(() => expect(screen.getByRole("option", { name: /a\.ts/ })).toBeDefined());
  return fake;
}

afterEach(() => {
  cleanup();
  resetUi();
});

describe("Merge ▾", () => {
  it("dispatches thread.merge with the chosen strategy and branch deletion", async () => {
    const fake = await mount();
    const trigger = screen.getByText("Merge ▾");
    expect(trigger.closest("button")?.getAttribute("title")).toBe("Merge tide/t1 → main");
    fireEvent.click(trigger);
    const panel = within(screen.getByLabelText("Merge options"));
    expect((panel.getByLabelText(/Squash/) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(panel.getByLabelText(/Rebase/));
    fireEvent.click(panel.getByLabelText("Delete branch after merge"));
    await act(async () => {
      fireEvent.click(panel.getByText("Merge"));
    });
    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "thread.merge",
      threadId: "t1",
      strategy: "rebase",
      deleteBranch: true,
    });
  });

  it("defaults to squash and leaves the branch", async () => {
    const fake = await mount();
    fireEvent.click(screen.getByText("Merge ▾"));
    await act(async () => {
      fireEvent.click(within(screen.getByLabelText("Merge options")).getByText("Merge"));
    });
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.merge", threadId: "t1", strategy: "squash" });
  });

  it.each<[string, Parameters<typeof makeThread>[1], boolean, string]>([
    ["no branch", {}, false, "This thread has no branch to merge"],
    ["running", worktree, true, "Wait for the turn to finish"],
    ["merging", { ...worktree, merge: { status: "merging", strategy: "squash", at: 1 } as Merge }, false, "A merge is already running"],
    ["merged", { ...worktree, mergedAt: 5 }, false, "Already merged"],
  ])("is disabled with a reason when %s", async (_name, patch, running, reason) => {
    const thread = makeThread("t1", { latestTurnId: "u1", ...patch });
    attachFakeStore(
      modelWithTurns(thread, [makeTurn("u1", { checkpoint, ...(running ? { status: "running" as const } : {}) })], [
        makeMessage("m1"),
      ]),
    );
    useUi.setState({ selectedThreadId: "t1", view: "thread" });
    mockRpc({ "vcs.turnDiff": () => diff(), "vcs.fileAt": () => ({ content: "x", binary: false, missing: false }) });
    render(<ChangesTab />);
    const button = (await screen.findByText("Merge ▾")).closest("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe(reason);
  });
});

describe("publish › merge when green", () => {
  it("sends mergeWhenGreen with the PR", async () => {
    const fake = await mount();
    fireEvent.click(screen.getByText("Commit…"));
    const group = within(screen.getByRole("radiogroup", { name: "Merge when green" }));
    fireEvent.click(group.getByLabelText("Squash"));
    await act(async () => {
      fireEvent.click(screen.getByText("Commit + push + PR"));
    });
    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.publish", commitOnly: false, mergeWhenGreen: "squash" }),
    );
  });

  it("leaves it out when off", async () => {
    const fake = await mount();
    fireEvent.click(screen.getByText("Commit…"));
    await act(async () => {
      fireEvent.click(screen.getByText("Commit + push + PR"));
    });
    const command = fake.dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(command.type).toBe("thread.publish");
    expect("mergeWhenGreen" in command).toBe(false);
  });
});

describe("merge state", () => {
  it("shows a spinner while merging", async () => {
    await mount({ merge: { status: "merging", strategy: "merge", at: 1 } });
    expect(screen.getByRole("status").textContent).toContain("Merging tide/t1 → main (merge)…");
  });

  it("lists conflicted files that open in the editor, and retries with the same strategy", async () => {
    const fake = await mount({
      merge: { status: "conflicted", strategy: "rebase", files: ["src/a.ts", "src/b.ts"], at: 1 },
    });
    const panel = within(screen.getByLabelText("Merge conflicts"));
    expect(panel.getByText("⚠ Merge conflicted in 2 files")).toBeDefined();
    expect(panel.getByText(/Resolve the conflicts in the worktree/)).toBeDefined();
    fireEvent.click(panel.getByText("src/b.ts"));
    expect(threadTabs("t1").some((t) => t.kind === "file" && t.path === "src/b.ts")).toBe(true);
    await act(async () => {
      fireEvent.click(panel.getByText("Retry merge"));
    });
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.merge", threadId: "t1", strategy: "rebase" });
  });

  it("shows the error inline with a retry", async () => {
    await mount({ merge: { status: "error", strategy: "squash", error: "base moved", at: 1 } });
    const panel = within(screen.getByLabelText("Merge error"));
    expect(panel.getByText("base moved")).toBeDefined();
    expect(panel.getByText("Retry merge")).toBeDefined();
  });

  it("says merged with the short sha", async () => {
    await mount({ mergedAt: 2, merge: { status: "merged", strategy: "squash", sha: "abcdef123456", at: 2 } });
    expect(screen.getByRole("status").textContent).toContain("✓ merged");
    expect(screen.getByRole("status").textContent).toContain("abcdef1");
  });
});
