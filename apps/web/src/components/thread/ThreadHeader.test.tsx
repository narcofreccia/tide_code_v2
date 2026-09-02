import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ThreadHeader } from "./ThreadHeader.tsx";
import { attachFakeStore, makeThread, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
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

    const button = await screen.findByText("Open in terminal");
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

    const button = await screen.findByText("Open in terminal");
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(RESUME));
  });

  it("disables the escape hatch until the harness has a session", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    mount();
    expect(screen.getByText<HTMLButtonElement>("Open in terminal").disabled).toBe(true);
  });

  it("creates a child thread on the same provider", async () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    const fake = mount();

    await act(async () => {
      fireEvent.click(screen.getByText("+ child"));
    });

    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.create", projectId: "p1", provider: "claude", parentThreadId: "t1" }),
    );
  });

  it("archives a worktree-less thread straight away", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    const fake = mount();
    fireEvent.click(screen.getByText("Archive"));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.archive", threadId: "t1" });
  });

  it("asks before archiving a thread that owns a worktree", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    const fake = mount({ worktreePath: "/wt/t1" });
    fireEvent.click(screen.getByText("Archive"));
    expect(fake.dispatch).not.toHaveBeenCalled();
    expect(useUi.getState().threadDialog).toEqual({ kind: "archive", threadId: "t1" });
  });

  it("opens the detach dialog from the overflow menu", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    mount({ worktreePath: "/wt/t1" });

    fireEvent.click(screen.getByTitle("More actions"));
    fireEvent.click(screen.getByText("Detach worktree…"));

    expect(useUi.getState().threadDialog).toEqual({ kind: "detach", threadId: "t1" });
  });
});
