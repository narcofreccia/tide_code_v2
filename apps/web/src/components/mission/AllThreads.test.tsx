import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AllThreads } from "./AllThreads.tsx";
import { MissionControl } from "./MissionControl.tsx";
import { App } from "../../App.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { setProvidersForTest } from "../../state/providers.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const project = { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 };

function fixture() {
  return modelWith({
    projects: { p1: project },
    threads: {
      t1: makeThread("t1", {
        title: "Recent",
        updatedAt: Date.now(),
        model: "opus",
        branch: "tide/recent",
        worktreePath: "/wt/recent",
        totalCostUsd: 1.5,
        pr: { url: "u", number: 3, state: "open", updatedAt: 1 },
      }),
      t2: makeThread("t2", { title: "Landed", provider: "codex", updatedAt: 1, mergedAt: 2, branch: "tide/landed" }),
      t3: makeThread("t3", { title: "Expert", role: "expert", updatedAt: 2 }),
      t4: makeThread("t4", { title: "Gone", archivedAt: 5 }),
      t5: makeThread("t5", { title: "Elsewhere", projectId: "p2" }),
    },
  });
}

describe("All threads", () => {
  it("lists every live thread of the project with provider, model, branch, PR, merged and cost", () => {
    attachFakeStore(fixture());
    render(<AllThreads projectId="p1" />);
    const list = within(screen.getByLabelText("Threads"));
    const rows = list.getAllByRole("button");
    expect(rows.map((r) => r.textContent?.includes("Recent") ? "Recent" : r.textContent?.includes("Expert") ? "Expert" : "Landed")).toEqual([
      "Recent",
      "Expert",
      "Landed",
    ]);
    const recent = rows[0] as HTMLElement;
    expect(recent.textContent).toContain("Claude Code");
    expect(recent.textContent).toContain("opus");
    expect(recent.textContent).toContain("tide/recent");
    expect(recent.textContent).toContain("⇡ open");
    expect(recent.textContent).toContain("$1.50");
    expect((rows[2] as HTMLElement).textContent).toContain("✓ merged");
    expect(screen.queryByText("Gone")).toBeNull();
    expect(screen.queryByText("Elsewhere")).toBeNull();

    fireEvent.click(recent);
    expect(useUi.getState().selectedThreadId).toBe("t1");
  });

  it("shows archived threads read-only behind the toggle", () => {
    attachFakeStore(fixture());
    render(<AllThreads projectId="p1" />);
    fireEvent.click(screen.getByLabelText("Archived"));
    const list = within(screen.getByLabelText("Archived threads"));
    expect(list.getByLabelText("Gone (archived)")).toBeDefined();
    expect(list.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByText("Recent")).toBeNull();
  });

  it("goes back to Mission Control", () => {
    attachFakeStore(fixture());
    useUi.getState().showAllThreads("p1");
    render(<AllThreads projectId="p1" />);
    fireEvent.click(screen.getByText("← Mission Control"));
    expect(useUi.getState().view).toBe("mission");
  });

  it("is what the app shows for the threads view", () => {
    attachFakeStore(fixture());
    setProvidersForTest([]);
    useUi.getState().showAllThreads("p1");
    render(<App />);
    expect(screen.getByLabelText("All threads")).toBeDefined();
    expect(window.location.hash).toBe("#/threads/p1");
  });
});

describe("Project card ⋯", () => {
  it("renames the project", () => {
    const fake = attachFakeStore(fixture());
    render(<MissionControl />);
    fireEvent.click(within(screen.getByLabelText("Project Tide")).getByText("⋯"));
    fireEvent.click(screen.getByText("Rename…"));
    const input = screen.getByLabelText("Project name");
    fireEvent.change(input, { target: { value: "Tide v2" } });
    fireEvent.click(screen.getByText("Rename"));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "project.update", projectId: "p1", title: "Tide v2" });
  });

  it("archives only after confirming", () => {
    const fake = attachFakeStore(fixture());
    render(<MissionControl />);
    fireEvent.click(within(screen.getByLabelText("Project Tide")).getByText("⋯"));
    fireEvent.click(screen.getByText("Archive project…"));
    expect(fake.dispatch).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog", { name: "Archive project" })).getByText("Archive"));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "project.archive", projectId: "p1" });
  });

  it("counts merged threads next to open PRs and shows lifetime cost", () => {
    attachFakeStore(fixture());
    render(<MissionControl />);
    const card = within(screen.getByLabelText("Project Tide"));
    expect(card.getByText("⇡ 1 open")).toBeDefined();
    expect(card.getByText("✓ 1 merged")).toBeDefined();
    expect(card.getByText("$0 lifetime")).toBeDefined();
  });
});
