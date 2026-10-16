import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ThreadHeader } from "./ThreadHeader.tsx";
import { attachFakeStore, makeThread, makeTurn, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { useTerminals } from "../../state/terminals.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
  vi.restoreAllMocks();
});

const RESUME = "claude --resume abc";

function mount(patch: Parameters<typeof makeThread>[1] = {}) {
  const thread = makeThread("t1", patch);
  const fake = attachFakeStore(modelWith({ threads: { t1: thread } }));
  render(<ThreadHeader thread={thread} />);
  return fake;
}

describe("ThreadHeader", () => {
  it("opens a terminal on the thread and types the resume command", async () => {
    const rpc = mockRpc({
      "thread.terminalCommand": () => ({ command: RESUME }),
      "pty.create": () => ({ ptyId: "pty-1" }),
      "pty.write": () => ({}),
    });
    mount({ worktreePath: "/wt/t1" });

    const button = await screen.findByRole("button", { name: "Terminal" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(button);
    });

    expect(rpc).toHaveBeenCalledWith("pty.create", { threadId: "t1", cols: 80, rows: 24 });
    expect(rpc).toHaveBeenCalledWith("pty.write", { ptyId: "pty-1", data: `${RESUME}\n` });
    expect(useTerminals.getState().drawerOpen).toBe(true);
  });

  it("falls back to the clipboard when no pty can be created", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mockRpc({
      "thread.terminalCommand": () => ({ command: RESUME }),
      "pty.create": () => {
        throw new Error("no pty host");
      },
    });
    mount();

    const button = await screen.findByRole("button", { name: "Terminal" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(RESUME));
  });

  it("disables the escape hatch until the harness has a session", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    mount();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Terminal" }).disabled).toBe(true);
  });

  it("has no Stop button (the composer owns Stop)", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    mount({ status: "running" });
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("folds Terminal and Fork into the menu when the container is narrow", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    let cb: ResizeObserverCallback = () => undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(c: ResizeObserverCallback) {
          cb = c;
        }
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
    mount();
    act(() => cb([{ contentRect: { width: 400 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(screen.queryByRole("button", { name: "Terminal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Fork" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: /Terminal/ })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: /Fork/ })).toBeDefined();
    vi.unstubAllGlobals();
  });

  it("forks from the latest settled turn", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    const thread = makeThread("t1", {});
    const model = modelWith({ threads: { t1: thread } });
    model.turns["u1"] = makeTurn("u1", { status: "completed" });
    attachFakeStore(model);
    render(<ThreadHeader thread={thread} />);
    fireEvent.click(screen.getByRole("button", { name: "Fork" }));
    expect(useUi.getState().threadDialog).toEqual({ kind: "fork", threadId: "t1", turnId: "u1" });
  });

  it("disables Fork until a turn has settled", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    mount();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Fork" }).disabled).toBe(true);
  });

  it("offers every secondary action in the ⋯ menu", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    mount({ worktreePath: "/wt/t1", branch: "tide/t1" });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    const names = screen.getAllByRole("menuitem").map((n) => n.textContent);
    expect(names).toEqual([
      "New child thread",
      "Roll back last turn…no finished turn",
      "Snooze▸",
      "Copy thread ID",
      "Copy branch",
      "Remove worktree…",
      "Archive thread…",
      "Delete thread",
    ]);
  });

  it("New child thread opens the new-thread form with the parent prefilled", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    const fake = mount();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /New child thread/ }));
    // the form decides provider, mode and worktree; nothing is created silently
    expect(fake.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "thread.create" }));
    expect(useUi.getState().newThreadParentId).toBe("t1");
    expect(useUi.getState().newThreadProjectId).toBe("p1");
  });

  it("rolls back the last settled turn through the existing dialog", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    const thread = makeThread("t1", {});
    const model = modelWith({ threads: { t1: thread } });
    model.turns["u1"] = makeTurn("u1", { status: "completed" });
    attachFakeStore(model);
    render(<ThreadHeader thread={thread} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Roll back last turn/ }));
    expect(useUi.getState().threadDialog).toEqual({ kind: "rollback", threadId: "t1", turnId: "u1" });
  });

  it("snoozes through the submenu", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    const fake = mount();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Snooze/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "1 hour" }));
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "thread.snooze", threadId: "t1" }));
  });

  it("archives a worktree-less thread straight away", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    const fake = mount();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Archive thread/ }));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.archive", threadId: "t1" });
  });

  it("asks before archiving a thread that owns a worktree", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    const fake = mount({ worktreePath: "/wt/t1" });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Archive thread/ }));
    expect(fake.dispatch).not.toHaveBeenCalled();
    expect(useUi.getState().threadDialog).toEqual({ kind: "archive", threadId: "t1" });
  });

  it("opens the detach dialog from Remove worktree…", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    mount({ worktreePath: "/wt/t1" });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Remove worktree/ }));
    expect(useUi.getState().threadDialog).toEqual({ kind: "detach", threadId: "t1" });
  });

  it("renames inline on double-click and commits on Enter", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    const fake = mount({ title: "Old name" });
    expect(screen.queryByLabelText("Thread title")).toBeNull();
    fireEvent.doubleClick(screen.getByText("Old name"));
    const input = screen.getByLabelText<HTMLInputElement>("Thread title");
    fireEvent.change(input, { target: { value: "  New name " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.update", threadId: "t1", title: "New name" });
    expect(screen.queryByLabelText("Thread title")).toBeNull();
  });

  it("renames from the pencil and reverts on Escape", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    const fake = mount({ title: "Old name" });
    fireEvent.click(screen.getByRole("button", { name: "Rename thread" }));
    const input = screen.getByLabelText<HTMLInputElement>("Thread title");
    fireEvent.change(input, { target: { value: "Nope" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(fake.dispatch).not.toHaveBeenCalled();
    expect(screen.getByText("Old name")).toBeDefined();
  });

  it("names the branch in a chip, or the main checkout when there is none", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    mount({ worktreePath: "/wt/t1", branch: "tide/t1" });
    expect(screen.getByText("⎇ tide/t1").getAttribute("title")).toBe("/wt/t1");
    cleanup();
    mount();
    expect(screen.getByText("main checkout")).toBeDefined();
  });

  it("renders the 24px sub-row only when there are chips to show", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    mount();
    expect(document.querySelector("header > div:nth-child(2)")).toBeNull();
    cleanup();
    mount({ forkedFrom: { threadId: "t1", turnId: "u1" } });
    expect(document.querySelector("header > div:nth-child(2)")).not.toBeNull();
  });
});

describe("ThreadHeader glass-box and merge state", () => {
  it("leaves ctx % and cost to the status bar", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    mount({ contextUsage: { used: 41_000, window: 200_000 }, totalCostUsd: 1.5 });
    expect(screen.queryByText("ctx 21%")).toBeNull();
    expect(screen.queryByText("$1.50")).toBeNull();
  });

  it("shows a limited rate-limit badge with the reset and the harness note", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    const resetsAt = Date.now() + 2 * 3600 * 1000;
    mount({ rateLimit: { status: "limited", resetsAt, note: "5-hour limit reached", at: 1 } });
    const badge = screen.getByLabelText(/rate limit limited/);
    expect(badge.textContent).toBe("⛔ limited · resets in 2h");
    expect(badge.getAttribute("title")).toContain("5-hour limit reached");
  });

  it("hides an ok rate limit", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    mount({ rateLimit: { status: "ok", at: 1 } });
    expect(screen.queryByLabelText(/rate limit/)).toBeNull();
  });

  it("reads ✓ merged once the branch landed", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    mount({ branch: "tide/t1", mergedAt: 5, merge: { status: "merged", strategy: "squash", at: 5 } });
    expect(screen.getByText("Merged")).toBeDefined();
    expect(screen.getAllByLabelText("merged").map((n) => n.textContent)).toEqual(["✓ merged"]);
  });

  it("flags a conflicted merge", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    mount({ branch: "tide/t1", merge: { status: "conflicted", strategy: "merge", files: ["a"], at: 5 } });
    expect(screen.getByLabelText("conflicted").textContent).toBe("⚠ conflicted");
  });
});

describe("ThreadHeader state chip", () => {
  const cases: Array<[string, Parameters<typeof makeThread>[1], string]> = [
    ["idle", {}, "Idle"],
    ["running", { status: "running" }, "Running"],
    ["needs you", { attention: "approval" }, "Needs you"],
    ["error", { status: "error" }, "Error"],
    ["interrupted", { status: "interrupted" }, "Interrupted"],
    ["limited", { limited: { resume: "reset", resetsAt: Date.now() + 2 * 3600 * 1000 + 5000, at: 1 } }, "Limited · resets in 2h"],
    ["merged", { mergedAt: 5 }, "Merged"],
  ];
  it.each(cases)("says %s in words, with a glyph", (_name, patch, word) => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    mount(patch);
    expect(screen.getByText(word)).toBeDefined();
  });

  it("keeps needs-you and interrupted visually distinct", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    mount({ attention: "approval" });
    const needs = document.querySelector("[data-state] span")?.textContent;
    cleanup();
    mount({ status: "interrupted" });
    const stopped = document.querySelector("[data-state] span")?.textContent;
    expect(needs).not.toBe(stopped);
  });
});

