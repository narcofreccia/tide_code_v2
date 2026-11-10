import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ThreadDialogHost } from "./ThreadDialogs.tsx";
import {
  attachFakeStore,
  makeThread,
  makeTurn,
  modelWithTurns,
  replyWithEvents,
  resetUi,
} from "../../testHarness.ts";
import { GEMINI, PROVIDER_FIXTURE } from "../settings/fixtures.ts";
import { setProvidersForTest } from "../../state/providers.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

function open(kind: "rollback" | "fork", threadPatch = {}, turnPatch = {}, providers = PROVIDER_FIXTURE) {
  setProvidersForTest(providers);
  const thread = makeThread("t1", { title: "Router", ...threadPatch });
  const fake = attachFakeStore(modelWithTurns(thread, [makeTurn("u1", turnPatch)]));
  useUi.setState({ threadDialog: { kind, threadId: "t1", turnId: "u1" } });
  render(<ThreadDialogHost />);
  return fake;
}

describe("rollback dialog", () => {
  it("disables Restore files without a worktree checkpoint", () => {
    const fake = open("rollback");
    const box = screen.getByLabelText("Restore files") as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(screen.getByText(/claude cannot forget turns/)).toBeDefined();
    fireEvent.click(screen.getByText("Roll back"));
    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.rollback", turnId: "u1", restoreFiles: false }),
    );
  });

  it("can opt out of restoring files", () => {
    const fake = open("rollback", { worktreePath: "/wt" }, { checkpoint: { before: "s0" } });
    fireEvent.click(screen.getByLabelText("Restore files"));
    fireEvent.click(screen.getByText("Roll back"));
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ restoreFiles: false }));
  });
});

describe("fork dialog", () => {
  it("forks with the defaults and selects the new thread", async () => {
    const fake = open("fork");
    replyWithEvents(fake, [{ type: "thread.created", thread: makeThread("t2", { title: "Router (fork)" }) } as never]);
    const dialog = screen.getByRole("dialog");
    expect((within(dialog).getByLabelText("Fork title") as HTMLInputElement).value).toBe("Router (fork)");
    // same caption style as Agent / Model
    expect(within(dialog).getByText("Title").className).toBe(within(dialog).getByText("Agent").className);
    expect((within(dialog).getByLabelText("Use a worktree") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByText("Fork"));
    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.fork",
        threadId: "t1",
        turnId: "u1",
        title: "Router (fork)",
        provider: "claude",
        useWorktree: true,
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(useUi.getState().selectedThreadId).toBe("t2");
  });

  it("shows and keeps the source thread's instance (an ACP agent is not a bundled harness)", () => {
    const fake = open("fork", { provider: "acp", providerId: "acp:gemini", model: "gemini-2.5-pro" }, {}, [...PROVIDER_FIXTURE, GEMINI]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("Fork provider").textContent).toContain("Gemini CLI");
    expect(within(dialog).getByLabelText("Fork provider").textContent).not.toContain("not configured");
    fireEvent.click(within(dialog).getByText("Fork"));
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "thread.fork", provider: "acp", model: "gemini-2.5-pro" }));
  });
});
