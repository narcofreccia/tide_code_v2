import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

function mount() {
  const fake = attachFakeStore(
    modelWith({
      threads: { t1: thread },
      messages: { m1: msg("m1", "user", "hello"), m2: msg("m2", "assistant", "hi there", true) },
      threadMessages: { t1: ["m1", "m2"] },
      turns: { u1: { id: "u1", threadId: "t1", status: "requested", requestedAt: 1 } },
    }),
  );
  useUi.setState({ selectedThreadId: "t1", view: "thread" });
  render(<ThreadView thread={thread} />);
  return fake;
}

afterEach(() => {
  cleanup();
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
    fireEvent.click(screen.getByText("Archive"));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.archive", threadId: "t1" });
    expect(useUi.getState().view).toBe("mission");
  });
});
