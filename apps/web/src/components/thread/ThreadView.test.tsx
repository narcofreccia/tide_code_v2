import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Message, Thread } from "@tide/contracts";
import { ThreadView } from "./ThreadView.tsx";
import { attachFakeStore, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";

const thread: Thread = {
  id: "t1",
  projectId: "p1",
  title: "Refactor router",
  provider: "claude",
  mode: "approval-required",
  interaction: "default",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
};

const msg = (id: string, role: Message["role"], text: string, streaming?: boolean): Message => ({
  id,
  threadId: "t1",
  turnId: "u1",
  role,
  text,
  createdAt: 1,
  ...(streaming === undefined ? {} : { streaming }),
});

function mount(t: Thread = thread) {
  const fake = attachFakeStore(
    modelWith({
      threads: { t1: t },
      messages: { m1: msg("m1", "user", "hello"), m2: msg("m2", "assistant", "hi there", true) },
      threadMessages: { t1: ["m1", "m2"] },
      turns: { u1: { id: "u1", threadId: "t1", status: "requested", requestedAt: 1 } },
    }),
  );
  useUi.setState({ selectedThreadId: "t1", view: "thread" });
  render(<ThreadView thread={t} />);
  return fake;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetUi();
});

describe("ThreadView", () => {
  it("renders the message stream with a streaming caret", () => {
    mount();
    expect(screen.getByText("hello")).toBeDefined();
    expect(screen.getByText(/hi there/)).toBeDefined();
    expect(screen.getByLabelText("streaming")).toBeDefined();
  });

  it("dispatches turn.request from the composer", () => {
    const fake = mount();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: " ship it " } });
    fireEvent.click(screen.getByText("Send"));
    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "turn.request", threadId: "t1", text: "ship it" }),
    );
  });

  it("sends on ⌘+Enter", () => {
    const fake = mount();
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "go" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "turn.request", threadId: "t1", text: "go" }),
    );
  });

  it("dispatches thread.archive and returns to Mission Control", () => {
    const fake = mount();
    fireEvent.click(screen.getByTitle("More actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Archive thread/ }));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.archive", threadId: "t1" });
    expect(useUi.getState().view).toBe("mission");
  });
});

describe("ThreadView: stuck banner", () => {
  const stuck: Thread = { ...thread, status: "running", latestTurnId: "u1", triage: { needsUser: 0, stuck: 0.78, urgency: 0.5, at: 1 } };
  const banner = (): HTMLElement => screen.getByText(/Looks stuck/).closest("div") as HTMLElement;

  it("shows how long the running thread has been idle and the judge's score", () => {
    vi.spyOn(Date, "now").mockReturnValue(1 + 12 * 60_000);
    mount(stuck);
    expect(screen.getByText("Looks stuck for 12 min (jev 0.78)")).toBeDefined();
  });

  it("stops the turn or nudges the agent", () => {
    const fake = mount(stuck);
    fireEvent.click(within(banner()).getByText("Stop"));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "turn.interrupt", threadId: "t1" });
    fireEvent.click(within(banner()).getByText("Nudge"));
    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "turn.steer", threadId: "t1", text: "Status check: what are you doing right now and what is blocking you?" }),
    );
  });

  it("is dismissed for the current turn", () => {
    mount(stuck);
    fireEvent.click(within(banner()).getByLabelText("Dismiss"));
    expect(screen.queryByText(/Looks stuck/)).toBeNull();
  });

  it("stays hidden below 0.7 or when the thread is not running", () => {
    mount({ ...stuck, triage: { needsUser: 0, stuck: 0.69, urgency: 0, at: 1 } });
    expect(screen.queryByText(/Looks stuck/)).toBeNull();
    cleanup();
    mount({ ...stuck, status: "idle" });
    expect(screen.queryByText(/Looks stuck/)).toBeNull();
  });
});
