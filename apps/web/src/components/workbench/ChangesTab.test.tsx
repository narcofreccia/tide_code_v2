import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  MonacoDiff: ({ original, modified }: { original: string; modified: string }) => (
    <div data-testid="monaco">{`${original}::${modified}`}</div>
  ),
}));

const cp = (before: string, after: string, additions = 10, deletions = 2) => ({
  before,
  after,
  stats: { files: 1, additions, deletions },
});

function diff(overrides: Partial<DiffResult> = {}): DiffResult {
  return {
    base: "sha-before",
    head: "WORKTREE",
    files: [{ path: "src/a.ts", status: "modified", additions: 10, deletions: 2, patch: "@@ -1 +1 @@\n-a\n+b\n" }],
    ...overrides,
  };
}

function setup(options: { pr?: boolean; running?: boolean } = {}) {
  const thread = makeThread("t1", {
    title: "Refactor router",
    worktreePath: "/wt/t1",
    branch: "tide/t1",
    ...(options.running ? { status: "running" as const, latestTurnId: "u2" } : { latestTurnId: "u2" }),
    ...(options.pr ? { pr: { url: "https://gh/pr/123", number: 123, state: "open" as const, updatedAt: 1 } } : {}),
  });
  const model = modelWithTurns(
    thread,
    [
      makeTurn("u1", { checkpoint: cp("s0", "s1", 5, 1) }),
      makeTurn("u2", {
        requestedAt: 2,
        ...(options.running ? { status: "running" as const } : {}),
        checkpoint: cp("s1", "s2"),
      }),
    ],
    [makeMessage("m1", { turnId: "u1", text: "first prompt" }), makeMessage("m2", { turnId: "u2", text: "second" })],
  );
  const fake = attachFakeStore(model);
  useUi.setState({ selectedThreadId: "t1", view: "thread" });
  return fake;
}

afterEach(() => {
  cleanup();
  resetUi();
});

describe("ChangesTab", () => {
  it("shows the empty state when no turn has a checkpoint", () => {
    const thread = makeThread("t1");
    attachFakeStore(modelWithTurns(thread, []));
    useUi.setState({ selectedThreadId: "t1", view: "thread" });
    mockRpc({});
    render(<ChangesTab />);
    expect(screen.getByText("No changes in this thread yet.")).toBeDefined();
  });

  it("fetches vcs.turnDiff for the latest checkpointed turn and renders the file + Monaco diff", async () => {
    setup();
    const rpc = mockRpc({
      "vcs.turnDiff": () => diff(),
      "vcs.fileAt": (params: { ref: string }) => ({
        content: params.ref === "WORKTREE" ? "after" : "before",
        binary: false,
        missing: false,
      }),
    });
    render(<ChangesTab />);

    await waitFor(() => expect(screen.getByRole("option", { name: /a\.ts/ })).toBeDefined());
    expect(rpc).toHaveBeenCalledWith("vcs.turnDiff", { threadId: "t1", turnId: "u2" });
    expect(screen.getByText("Turn 2 of 2 ▾")).toBeDefined();
    expect(await screen.findByTestId("monaco")).toHaveProperty("textContent", "before::after");
  });

  it("steps turns with [ and ] and switches to the whole-thread diff", async () => {
    setup();
    const rpc = mockRpc({
      "vcs.turnDiff": () => diff(),
      "vcs.threadDiff": () => diff({ files: [] }),
      "vcs.fileAt": () => ({ content: "x", binary: false, missing: false }),
    });
    render(<ChangesTab />);
    await waitFor(() => expect(screen.getByText("Turn 2 of 2 ▾")).toBeDefined());

    act(() => {
      fireEvent.keyDown(window, { key: "[" });
    });
    await waitFor(() => expect(screen.getByText("Turn 1 of 2 ▾")).toBeDefined());
    expect(rpc).toHaveBeenCalledWith("vcs.turnDiff", { threadId: "t1", turnId: "u1" });

    act(() => {
      fireEvent.keyDown(window, { key: "]" });
    });
    await waitFor(() => expect(screen.getByText("Turn 2 of 2 ▾")).toBeDefined());

    fireEvent.click(screen.getByText("Turn 2 of 2 ▾"));
    fireEvent.click(screen.getByText("All changes"));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("vcs.threadDiff", { threadId: "t1" }));
    expect(screen.getByText(`All changes ▾`)).toBeDefined();
  });

  it("falls back to the patch view for a binary file", async () => {
    setup();
    mockRpc({
      "vcs.turnDiff": () =>
        diff({ files: [{ path: "img.png", status: "modified", additions: 0, deletions: 0, binary: true, patch: "@@ binary @@" }] }),
    });
    render(<ChangesTab />);

    expect(await screen.findByTestId("patch-view")).toBeDefined();
    expect(screen.queryByTestId("monaco")).toBeNull();
  });

  it("confirms before dispatching thread.revert", async () => {
    const fake = setup();
    mockRpc({ "vcs.turnDiff": () => diff(), "vcs.fileAt": () => ({ content: "x", binary: false, missing: false }) });
    render(<ChangesTab />);
    await waitFor(() => expect(screen.getByRole("option", { name: /a\.ts/ })).toBeDefined());

    fireEvent.click(screen.getByText("Revert this turn"));
    expect(fake.dispatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Revert"));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.revert", threadId: "t1", turnId: "u2" });
  });

  it("publishes with commitOnly true or false from the popover", async () => {
    const fake = setup();
    mockRpc({
      "vcs.turnDiff": () => diff(),
      "vcs.status": () => ({ cwd: "/wt/t1", isRepo: true, worktree: true, dirty: 1, hasGh: true, hasRemote: true }),
      "vcs.fileAt": () => ({ content: "x", binary: false, missing: false }),
    });
    render(<ChangesTab />);
    await waitFor(() => expect(screen.getByRole("option", { name: /a\.ts/ })).toBeDefined());

    fireEvent.click(screen.getByText("Commit…"));
    const title = screen.getByLabelText("Commit title") as HTMLInputElement;
    expect(title.value).toBe("Refactor router");
    expect((screen.getByLabelText("Commit body") as HTMLTextAreaElement).value).toBe("first prompt");
    fireEvent.change(title, { target: { value: "New title" } });
    fireEvent.click(screen.getByText("Commit"));
    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "thread.publish",
      threadId: "t1",
      title: "New title",
      body: "first prompt",
      commitOnly: true,
    });

    // the popover keeps what was typed
    fireEvent.click(screen.getByText("Commit…"));
    fireEvent.click(screen.getByText("Commit + push + PR"));
    expect(fake.dispatch).toHaveBeenLastCalledWith({
      type: "thread.publish",
      threadId: "t1",
      title: "New title",
      body: "first prompt",
      commitOnly: false,
    });
  });

  it("shows the PR badge and a refresh instead of the commit popover", async () => {
    setup({ pr: true });
    const rpc = mockRpc({
      "vcs.turnDiff": () => diff(),
      "vcs.status": () => ({ cwd: "/wt/t1", isRepo: true, worktree: true, dirty: 0, hasGh: true, hasRemote: true }),
      "vcs.fileAt": () => ({ content: "x", binary: false, missing: false }),
    });
    render(<ChangesTab />);
    await waitFor(() => expect(screen.getByRole("option", { name: /a\.ts/ })).toBeDefined());

    const badge = screen.getByText("#123 open");
    expect(badge.getAttribute("href")).toBe("https://gh/pr/123");
    expect(screen.queryByText("Commit…")).toBeNull();
    fireEvent.click(screen.getByText("Refresh"));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("vcs.turnDiff", { threadId: "t1", turnId: "u2" }));
  });

  it("disables revert and commit while a turn is running", async () => {
    setup({ running: true });
    mockRpc({ "vcs.turnDiff": () => diff(), "vcs.fileAt": () => ({ content: "x", binary: false, missing: false }) });
    render(<ChangesTab />);
    await waitFor(() => expect(screen.getByRole("option", { name: /a\.ts/ })).toBeDefined());

    expect((screen.getByText("Revert this turn") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Commit…") as HTMLButtonElement).disabled).toBe(true);
  });
});
