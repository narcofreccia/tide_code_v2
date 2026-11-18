import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThreadHeader } from "./ThreadHeader.tsx";
import { attachFakeStore, makeThread, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

function mount(patch: Parameters<typeof makeThread>[1]) {
  mockRpc({ "thread.terminalCommand": () => ({ cwd: "/", command: "claude" }) });
  const source = makeThread("src", { title: "Original" });
  const thread = makeThread("t1", patch);
  const fake = attachFakeStore(modelWith({ threads: { src: source, t1: thread } }));
  render(<ThreadHeader thread={thread} />);
  return fake;
}

describe("thread header R4", () => {
  it("links back to the fork source", () => {
    mount({ forkedFrom: { threadId: "src", turnId: "u1" } });
    fireEvent.click(screen.getByText("forked from Original"));
    expect(useUi.getState().selectedThreadId).toBe("src");
  });

  it("offers the limited menu", () => {
    const fake = mount({ limited: { resume: "manual", at: 1, resetsAt: Date.now() + 7_200_000 } });
    fireEvent.click(screen.getByText(/Resume options/));
    fireEvent.click(screen.getByText("Resume now"));
    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.resume", threadId: "t1", continue: true }),
    );
    fireEvent.click(screen.getByText(/Resume options/));
    fireEvent.click(screen.getByText("Resume at reset"));
    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.limit-policy", resume: "reset" }),
    );
    fireEvent.click(screen.getByText(/Resume options/));
    fireEvent.click(screen.getByText("Snooze 1h"));
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "thread.snooze", threadId: "t1" }));
  });

  it("R20: once a manual thread's limit reset, the header asks to continue and Continue leads the menu", () => {
    const fake = mount({ limited: { resume: "manual", at: 1, resetsAt: Date.now() - 1000 } });
    expect(screen.getByText("Limit reset, continue?")).toBeDefined();
    fireEvent.click(screen.getByText(/Continue options/));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "thread.resume", threadId: "t1", continue: true }));
  });

  it("R20: a chip says the project quota holds the thread", () => {
    mockRpc({ "thread.terminalCommand": () => ({ cwd: "/", command: "claude" }) });
    const thread = makeThread("t1");
    const quotaState = { status: "exceeded" as const, usedPct: 103, basis: "share" as const, over: ["claude"], windowEndsAt: Date.now() + 86_400_000, at: 1 };
    const project = { id: "p1", title: "Side project", rootPath: "/p1", createdAt: 1, updatedAt: 1, quota: { sharePct: 30, onExceed: "hold" as const }, quotaState };
    attachFakeStore(modelWith({ projects: { p1: project }, threads: { t1: thread } }));
    render(<ThreadHeader thread={thread} />);
    const chip = screen.getByText("Held by quota");
    expect(chip.getAttribute("title")).toContain("≈ 31% of the weekly window, cap 30%");
    // Open in terminal stays available
    expect(screen.getByRole("button", { name: /Terminal/ })).toBeDefined();
  });

  it("does not offer Resume now on a thread whose worktree is gone; it says why", () => {
    const fake = mount({ branch: "tide/t1", limited: { resume: "manual", at: 1 } });
    fireEvent.click(screen.getByText(/Resume options/));
    const resume = screen.getByRole("button", { name: "Resume now" }) as HTMLButtonElement;
    expect(resume.disabled).toBe(true);
    expect(resume.title).toBe("This thread's worktree was removed.");
    fireEvent.click(resume);
    expect(fake.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "thread.resume" }));
    // the other choices do not start a turn, so they stay
    expect((screen.getByRole("button", { name: /Resume at reset/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows rollback progress and failure", () => {
    mount({ rollback: { status: "rolling", turnId: "u1", restoreFiles: true, at: 1 } });
    expect(screen.getByText(/Rolling back/)).toBeDefined();
    cleanup();
    mount({ rollback: { status: "error", turnId: "u1", restoreFiles: true, at: 1, error: "dirty tree" } });
    expect(screen.getByRole("alert").textContent).toContain("dirty tree");
  });
});
