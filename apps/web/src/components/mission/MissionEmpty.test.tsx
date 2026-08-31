import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MissionControl } from "./MissionControl.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { setProvidersForTest } from "../../state/providers.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const caps = {
  planMode: true,
  subagents: true,
  mcp: true,
  images: true,
  resume: true,
  contextUsage: true,
  openInTerminal: true,
};

function providers(loggedIn: boolean) {
  setProvidersForTest([
    { kind: "claude", installed: true, loggedIn, models: [], caps },
    { kind: "codex", installed: false, loggedIn: false, models: [], caps },
    { kind: "opencode", installed: false, loggedIn: false, models: [], caps },
    { kind: "pi", installed: true, loggedIn: false, models: [], caps },
  ]);
}

describe("Mission Control empty state", () => {
  it("shows the mark, the sentence and a checklist that no step is done in", () => {
    providers(false);
    attachFakeStore(modelWith({}));
    const { container } = render(<MissionControl />);
    expect(container.querySelector("svg")?.getAttribute("width")).toBe("40");
    expect(screen.getByText("Tide")).toBeDefined();
    expect(screen.getByText("Threads on any coding harness, each on its own worktree.")).toBeDefined();

    const list = screen.getByLabelText("Getting started");
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    for (const step of ["1 Add a repository", "2 Log in to a harness", "3 Start a thread"]) {
      expect(screen.getByLabelText(step).dataset["done"]).toBe("false");
    }
    expect(screen.getByText("None of the four are logged in yet.")).toBeDefined();
    // step 3 cannot run before step 1
    expect((screen.getByText("New thread").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("ticks the harness step off and names which are ready", () => {
    providers(true);
    attachFakeStore(modelWith({}));
    render(<MissionControl />);
    expect(screen.getByLabelText("2 Log in to a harness").dataset["done"]).toBe("true");
    expect(screen.getByText("Ready: Claude Code")).toBeDefined();
    expect(screen.getByLabelText("1 Add a repository").dataset["done"]).toBe("false");
  });

  it("opens the rail's add-project form from the first step", () => {
    providers(false);
    attachFakeStore(modelWith({}));
    useUi.setState({ railCollapsed: true });
    render(<MissionControl />);
    fireEvent.click(screen.getByText("Add repository"));
    expect(useUi.getState().newProjectOpen).toBe(true);
    expect(useUi.getState().railCollapsed).toBe(false);
  });

  it("gives way to the real view once a project exists", () => {
    providers(true);
    attachFakeStore(
      modelWith({
        projects: { p1: { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 } },
        threads: { t1: makeThread("t1") },
      }),
    );
    render(<MissionControl />);
    expect(screen.queryByLabelText("Getting started")).toBeNull();
    expect(screen.getByLabelText("Project Tide")).toBeDefined();
  });
});
