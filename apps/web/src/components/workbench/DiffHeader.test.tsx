import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DiffResult } from "@tide/contracts";
import { useUi } from "../../state/ui.ts";
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

const NO_WORKTREE_HINT = "Runs in the main checkout — revert and PR need a worktree";

const checkpoint = { before: "s0", after: "s1", stats: { files: 1, additions: 3, deletions: 1 } };

function diff(): DiffResult {
  return {
    base: "s0",
    head: "WORKTREE",
    files: [{ path: "src/a.ts", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b\n" }],
  };
}

function setup(patch: Parameters<typeof makeThread>[1] = {}) {
  const thread = makeThread("t1", { latestTurnId: "u1", ...patch });
  const model = modelWithTurns(thread, [makeTurn("u1", { checkpoint })], [makeMessage("m1", { text: "prompt" })]);
  const fake = attachFakeStore(model);
  useUi.setState({ selectedThreadId: "t1", view: "thread" });
  return fake;
}

const withWorktree = { worktreePath: "/wt/t1", branch: "tide/t1" };
const pr = { pr: { url: "https://gh/pr/7", number: 7, state: "open" as const, updatedAt: 1 } };

afterEach(() => {
  cleanup();
  resetUi();
});

describe("DiffHeader git actions", () => {
  it("offers revert and commit on a worktree thread", async () => {
    setup(withWorktree);
    mockRpc({ "vcs.turnDiff": () => diff(), "vcs.fileAt": () => ({ content: "x", binary: false, missing: false }) });
    render(<ChangesTab />);

    await waitFor(() => expect(screen.getByRole("option", { name: /a\.ts/ })).toBeDefined());
    expect(screen.getByText("Revert this turn")).toBeDefined();
    expect(screen.getByText("Commit…")).toBeDefined();
    expect(screen.queryByText(NO_WORKTREE_HINT)).toBeNull();
  });

  it("hides revert and commit on a thread running in the main checkout", async () => {
    setup();
    mockRpc({ "vcs.turnDiff": () => diff(), "vcs.fileAt": () => ({ content: "x", binary: false, missing: false }) });
    render(<ChangesTab />);

    await waitFor(() => expect(screen.getByRole("option", { name: /a\.ts/ })).toBeDefined());
    expect(screen.getByText(NO_WORKTREE_HINT)).toBeDefined();
    expect(screen.queryByText("Revert this turn")).toBeNull();
    expect(screen.queryByText("Commit…")).toBeNull();
    expect(screen.queryByText("Commit & update PR")).toBeNull();
  });

  it("keeps a publish action next to the PR badge so follow-up turns can be pushed", async () => {
    setup({ ...withWorktree, ...pr });
    mockRpc({ "vcs.turnDiff": () => diff(), "vcs.fileAt": () => ({ content: "x", binary: false, missing: false }) });
    render(<ChangesTab />);

    await waitFor(() => expect(screen.getByRole("option", { name: /a\.ts/ })).toBeDefined());
    expect(screen.getByRole("link", { name: /#7 open/ })).toBeDefined();
    fireEvent.click(screen.getByText("Commit & update PR"));
    expect(screen.getByText("Commit + push + update PR")).toBeDefined();
  });

  it("Refresh re-reads the diff and the git status", async () => {
    setup({ ...withWorktree, ...pr });
    const rpc = mockRpc({
      "vcs.turnDiff": () => diff(),
      "vcs.status": () => ({ cwd: "/wt/t1", branch: "tide/t1", ahead: 0, behind: 0, files: [], hasGh: true }),
      "vcs.fileAt": () => ({ content: "x", binary: false, missing: false }),
    });
    render(<ChangesTab />);
    await waitFor(() => expect(screen.getByRole("option", { name: /a\.ts/ })).toBeDefined());
    const diffCalls = rpc.mock.calls.filter(([method]) => method === "vcs.turnDiff").length;

    fireEvent.click(screen.getByText("Refresh"));

    await waitFor(() => expect(rpc).toHaveBeenCalledWith("vcs.status", { threadId: "t1" }));
    expect(rpc.mock.calls.filter(([method]) => method === "vcs.turnDiff").length).toBe(diffCalls + 1);
  });
});
