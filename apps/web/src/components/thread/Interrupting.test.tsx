import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Composer } from "./Composer.tsx";
import { ThreadHeader } from "./ThreadHeader.tsx";
import { StatusBar } from "../shell/StatusBar.tsx";
import { MissionControl } from "../mission/MissionControl.tsx";
import { attachFakeStore, makeThread, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const thread = makeThread("t1", { title: "Refactor router", status: "running", interrupting: true });

function attach() {
  mockRpc({
    "thread.terminalCommand": () => ({ cwd: "/repo" }),
    "vcs.status": () => ({ branch: "main", worktree: false, cwd: "/repo", dirty: false, files: [] }),
  });
  return attachFakeStore(
    modelWith({
      projects: { p1: { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 } },
      threads: { t1: thread },
    }),
  );
}

describe("interrupting state", () => {
  it("disables Stop and says so in the composer", () => {
    attach();
    render(<Composer thread={thread} />);
    expect((screen.getByText("Stop").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("interrupting…")).toBeDefined();
  });

  it("shows it in the thread header and the status bar", () => {
    attach();
    useUi.setState({ selectedThreadId: "t1", view: "thread" });
    render(
      <>
        <ThreadHeader thread={thread} />
        <StatusBar />
      </>,
    );
    expect(screen.getAllByText("interrupting…").length).toBeGreaterThan(0);
    expect(screen.getAllByTitle("interrupting…").length).toBeGreaterThan(0);
    expect(screen.getByText(/thread: interrupting…/)).toBeDefined();
  });

  it("marks the thread in Mission Control", () => {
    attach();
    render(<MissionControl />);
    expect(screen.getAllByLabelText("interrupting…").length).toBe(1);
    expect(screen.getByText("interrupting…")).toBeDefined();
  });
});
