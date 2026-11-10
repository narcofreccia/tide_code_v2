import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Activity, Thread, Turn } from "@tide/contracts";
import { ActivityRow } from "./ActivityRow.tsx";
import { registerComposerFocus } from "../../lib/composerFocus.ts";
import { isFreshSessionArmed, useFreshSession } from "../../state/freshSession.ts";
import { attachFakeStore, makeThread, makeTurn, modelWith, resetUi, type FakeStore } from "../../testHarness.ts";

const TEXT = "Claude Code could not reopen its session (No conversation found with session ID: sess-1)";

/** What the server writes for a refused resume (apps/server/src/provider/sessionNotices.ts). */
const refused: Activity = {
  id: "a1",
  threadId: "t1",
  turnId: "u2",
  createdAt: 2,
  updatedAt: 2,
  kind: "error",
  text: TEXT,
  payload: { code: "resume-refused", harness: "No conversation found with session ID: sess-1" },
};

function setup(thread: Partial<Thread> = {}, turns: Record<string, Turn> = {}): FakeStore {
  return attachFakeStore(modelWith({ threads: { t1: makeThread("t1", thread) }, turns: { u2: makeTurn("u2", { status: "error", requestedAt: 2 }), ...turns } }));
}

function renderRow(activity: Activity = refused): void {
  render(
    <ul>
      <ActivityRow activity={activity} />
    </ul>,
  );
}

afterEach(() => {
  cleanup();
  resetUi();
  useFreshSession.setState({ armed: {} });
});

describe("refused resume row (R19 L5)", () => {
  it("explains the fresh session, and the action arms it and focuses the composer without sending anything", () => {
    const fake = setup();
    const focus = vi.fn();
    const unregister = registerComposerFocus(focus);
    renderRow();

    expect(screen.getByText(TEXT)).toBeDefined();
    expect(screen.getByText("A fresh session keeps this thread and its files, but the agent starts without the earlier conversation.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Start a fresh session" }));

    expect(isFreshSessionArmed("t1")).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(fake.dispatch).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Start a fresh session" })).toBeNull();
    expect(screen.getByText("Your next message starts a fresh session.")).toBeDefined();
    unregister();
  });

  it("waits while a turn runs", () => {
    setup({ status: "running" });
    renderRow();
    expect((screen.getByRole("button", { name: "Start a fresh session" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("drops the action once a fresh session began after this turn", () => {
    setup({ sessionBoundaryTurnId: "u3" }, { u3: makeTurn("u3", { requestedAt: 3, freshSession: true }) });
    renderRow();
    expect(screen.getByText(TEXT)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Start a fresh session" })).toBeNull();
  });

  it("an error without the marker stays a plain error line", () => {
    setup();
    renderRow({ ...refused, payload: undefined, text: "No conversation found with session ID: sess-1" });
    expect(screen.queryByRole("button", { name: "Start a fresh session" })).toBeNull();
  });
});
