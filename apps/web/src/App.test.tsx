import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App } from "./App.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "./testHarness.ts";
import { useUi } from "./state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

describe("App shell", () => {
  it("lands on Mission Control and shows the status bar", () => {
    attachFakeStore(modelWith({}));
    render(<App />);
    expect(screen.getByLabelText("Mission Control")).toBeDefined();
    expect(screen.getByText("connected")).toBeDefined();
    expect(screen.getAllByText("Inbox").length).toBeGreaterThan(0);
  });

  it("switches focus mode with ⌘1/⌘2/⌘3 and toggles the rail with ⌘B", () => {
    attachFakeStore(modelWith({ threads: { t1: makeThread("t1") } }));
    // focus modes are thread-scoped: they need one selected
    useUi.getState().selectThread("t1");
    render(<App />);
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    expect(useUi.getState().focusMode).toBe("thread");
    fireEvent.keyDown(window, { key: "3", metaKey: true });
    expect(useUi.getState().focusMode).toBe("workbench");
    fireEvent.keyDown(window, { key: "b", metaKey: true });
    expect(useUi.getState().railCollapsed).toBe(true);
  });

  it("hides the focus switch on Mission Control and shows it on a thread", () => {
    attachFakeStore(modelWith({ threads: { t1: makeThread("t1") } }));
    render(<App />);
    expect(screen.queryByLabelText("Focus mode")).toBeNull();

    cleanup();
    useUi.getState().selectThread("t1");
    render(<App />);
    expect(screen.getByLabelText("Focus mode")).toBeDefined();
  });

  it("shows the thread and workbench columns when a thread is selected", () => {
    attachFakeStore(
      modelWith({
        threads: {
          t1: {
            id: "t1",
            projectId: "p1",
            title: "Refactor router",
            provider: "claude",
            mode: "auto",
            interaction: "default",
            status: "idle",
            createdAt: 1,
            updatedAt: 1,
          },
        },
        threadMessages: { t1: [] },
      }),
    );
    useUi.setState({ selectedThreadId: "t1", view: "thread", focusMode: "split" });
    render(<App />);
    expect(screen.getByLabelText("Thread")).toBeDefined();
    expect(screen.getByLabelText("Workbench")).toBeDefined();
    expect(screen.getByText("No changes in this thread yet.")).toBeDefined();
    expect(screen.getByLabelText("Resize thread and workbench")).toBeDefined();
  });
});
