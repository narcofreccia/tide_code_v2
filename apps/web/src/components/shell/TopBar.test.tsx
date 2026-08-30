import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Thread } from "@tide/contracts";
import { TopBar } from "./TopBar.tsx";
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

afterEach(() => {
  cleanup();
  resetUi();
});

describe("TopBar", () => {
  it("renames the thread on Enter and switches provider", () => {
    const fake = attachFakeStore(modelWith({ threads: { t1: thread } }));
    useUi.setState({ selectedThreadId: "t1", view: "thread" });
    render(<TopBar />);

    const title = screen.getByLabelText<HTMLInputElement>("Thread title");
    expect(title.value).toBe("Refactor router");
    fireEvent.change(title, { target: { value: "Router cleanup" } });
    fireEvent.blur(title);
    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "thread.update",
      threadId: "t1",
      title: "Router cleanup",
    });

    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "codex" } });
    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "thread.update",
      threadId: "t1",
      provider: "codex",
    });
  });
});
