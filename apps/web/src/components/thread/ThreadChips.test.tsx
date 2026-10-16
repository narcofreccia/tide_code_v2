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

  it("shows rollback progress and failure", () => {
    mount({ rollback: { status: "rolling", turnId: "u1", restoreFiles: true, at: 1 } });
    expect(screen.getByText(/Rolling back/)).toBeDefined();
    cleanup();
    mount({ rollback: { status: "error", turnId: "u1", restoreFiles: true, at: 1, error: "dirty tree" } });
    expect(screen.getByRole("alert").textContent).toContain("dirty tree");
  });
});
