import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ScheduledTask } from "@tide/contracts";
import { AutomationsSection } from "./AutomationsSection.tsx";
import { attachFakeStore, chooseOption, makeThread, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { setProvidersForTest } from "../../state/providers.ts";
import { PROVIDER_FIXTURE } from "./fixtures.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const project = { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 };
const task = (id: string, patch: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id,
  projectId: "p1",
  title: `Task ${id}`,
  prompt: "do it",
  schedule: { kind: "interval", everyMs: 30 * 60_000 },
  enabled: true,
  runs: 3,
  updatedAt: 1,
  createdAt: 1,
  ...patch,
});

function setup(tasks: ScheduledTask[]) {
  setProvidersForTest(PROVIDER_FIXTURE);
  mockRpc({});
  useUi.setState({ selectedProjectId: "p1" });
  const model = modelWith({
    projects: { p1: project },
    threads: { t1: makeThread("t1", { title: "Nightly thread" }) },
    scheduledTasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
  });
  const fake = attachFakeStore(model);
  render(<AutomationsSection />);
  return fake;
}

describe("Settings › Automations", () => {
  it("renders schedule words, target, next run and runs", () => {
    setup([
      task("a", { nextRunAt: Date.now() + 3 * 3600_000, provider: "codex" }),
      task("b", { schedule: { kind: "fixed", times: ["09:00"], weekdays: [1, 2, 3, 4, 5] }, threadId: "t1", lastRunAt: Date.now() - 600_000, lastRunThreadId: "t1" }),
    ]);
    expect(screen.getByText("every 30 min")).toBeDefined();
    expect(screen.getByText("Mon–Fri at 09:00")).toBeDefined();
    expect(screen.getByText("new thread on codex")).toBeDefined();
    expect(screen.getByText("Nightly thread")).toBeDefined();
    expect(screen.getByText("next in 3h")).toBeDefined();
    expect(screen.getByText("last 10m ago")).toBeDefined();
    expect(screen.getAllByText("3 runs")).toHaveLength(2);
  });

  it("toggles enabled, runs now and deletes after confirming", () => {
    const fake = setup([task("a")]);
    fireEvent.click(screen.getByLabelText("Enable Task a"));
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "task.update", taskId: "a", enabled: false }));
    fireEvent.click(screen.getByText("Run now"));
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "task.run-now", taskId: "a", commandId: expect.any(String) }));
    fireEvent.click(screen.getByText("Delete"));
    expect(fake.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "task.delete" }));
    fireEvent.click(screen.getAllByText("Delete").at(-1) as HTMLElement);
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "task.delete", taskId: "a" }));
  });

  it("creates an interval task", () => {
    const fake = setup([]);
    fireEvent.click(screen.getByText("New automation"));
    fireEvent.click(screen.getByText("Create"));
    expect(screen.getByRole("alert").textContent).toContain("title");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Sweep" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "tidy up" } });
    fireEvent.change(screen.getByLabelText("Interval"), { target: { value: "2" } });
    chooseOption("Interval unit", "hours");
    fireEvent.click(screen.getByText("Create"));
    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "task.create",
        projectId: "p1",
        title: "Sweep",
        prompt: "tidy up",
        schedule: { kind: "interval", everyMs: 7_200_000 },
        enabled: true,
        useWorktree: true,
      }),
    );
  });

  it("creates a fixed-time task into an existing thread and validates times", () => {
    const fake = setup([]);
    fireEvent.click(screen.getByText("New automation"));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Morning" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "status?" } });
    fireEvent.click(screen.getByLabelText("At fixed times"));
    fireEvent.click(screen.getByText("Create"));
    expect(screen.getByRole("alert").textContent).toContain("at least one time");
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "9am" } });
    fireEvent.click(screen.getByText("Add time"));
    expect(screen.getByRole("alert").textContent).toContain("09:00");
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "08:30" } });
    fireEvent.click(screen.getByText("Add time"));
    fireEvent.click(screen.getByLabelText("An existing thread"));
    chooseOption("Thread", "Nightly thread");
    fireEvent.click(screen.getByText("Create"));
    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "task.create",
        schedule: { kind: "fixed", times: ["08:30"], weekdays: [1, 2, 3, 4, 5] },
        threadId: "t1",
      }),
    );
  });
});
