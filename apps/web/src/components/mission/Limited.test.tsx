import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MissionControl } from "./MissionControl.tsx";
import { useUi } from "../../state/ui.ts";
import { attachFakeStore, makeApproval, makeMessage, makeThread, modelWith, resetUi } from "../../testHarness.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const project = { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 };
const pr = { url: "u", number: 7, state: "open" as const, updatedAt: 1 };

describe("Mission Control R4 sections", () => {
  it("lists limited threads and dispatches resume / policy", () => {
    const now = Date.now();
    const model = modelWith({
      projects: { p1: project },
      threads: {
        t1: makeThread("t1", { title: "Stuck", limited: { resume: "manual", at: now, resetsAt: now + 3 * 3600_000 } }),
      },
    });
    const fake = attachFakeStore(model);
    render(<MissionControl />);
    const section = screen.getByLabelText("Limited");
    expect(section.textContent).toContain("resets in 3h");
    fireEvent.click(screen.getByText("Resume now"));
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "thread.resume", threadId: "t1", continue: true }));
    fireEvent.click(screen.getByText("At reset"));
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "thread.limit-policy", resume: "reset" }));
  });

  it("hides Limited when empty; snoozed threads are collapsed and can be unsnoozed", () => {
    const model = modelWith({
      projects: { p1: project },
      threads: { t1: makeThread("t1", { title: "Later", attention: "approval", snoozedUntil: Date.now() + 3600_000 }) },
    });
    const fake = attachFakeStore(model);
    render(<MissionControl />);
    expect(screen.queryByLabelText("Limited")).toBeNull();
    expect(screen.queryByLabelText("Inbox: Later")).toBeNull();
    fireEvent.click(screen.getByText(/Snoozed · 1/));
    fireEvent.click(screen.getByText("Unsnooze"));
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "thread.resume", threadId: "t1" }));
  });

  it("shows the delegate role, the PR pill with conflict, and the notification subtitle", () => {
    const model = modelWith({
      projects: { p1: project },
      threads: {
        t1: makeThread("t1", {
          title: "Reviewer",
          delegateRole: "review",
          prWatch: { since: 1 },
          pr: { ...pr, checks: "failure", comments: 2, mergeable: false },
        }),
        t2: makeThread("t2", { title: "Woken", attention: "question", latestTurnId: "u1" }),
      },
    });
    model.messages["m1"] = makeMessage("m1", {
      threadId: "t2",
      turnId: "u1",
      notification: { source: "pr", summary: "CI failed on #7" },
    });
    model.threadMessages["t2"] = ["m1"];
    model.activities["a1"] = makeApproval("a1", { threadId: "t2" });
    model.threadTimeline["t2"] = [{ kind: "activity", id: "a1" }];
    attachFakeStore(model);
    render(<MissionControl />);
    expect(screen.getByText("review")).toBeDefined();
    expect(screen.getByText(/👁 PR #7 · ✘ · 2 comments/)).toBeDefined();
    expect(screen.getByText(/conflict/)).toBeDefined();
    expect(screen.getByText("CI failed on #7")).toBeDefined();
  });
});

describe("Project automations line", () => {
  it("summarises tasks and opens Settings › Automations", () => {
    const now = Date.now();
    const base = { projectId: "p1", prompt: "x", schedule: { kind: "interval" as const, everyMs: 60_000 }, enabled: true, runs: 0, createdAt: 1, updatedAt: 1 };
    const model = modelWith({
      projects: { p1: project },
      scheduledTasks: {
        a: { ...base, id: "a", title: "A", nextRunAt: now + 5 * 60_000 },
        b: { ...base, id: "b", title: "B", nextRunAt: now + 60 * 60_000 },
      },
    });
    attachFakeStore(model);
    render(<MissionControl />);
    fireEvent.click(screen.getByText(/2 automations · next in 5m/));
    expect(useUi.getState().view).toBe("settings");
    expect(useUi.getState().settingsSection).toBe("automations");
  });
});
