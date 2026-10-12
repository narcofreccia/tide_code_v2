import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReadModel } from "@tide/contracts";
import { MissionControl } from "./MissionControl.tsx";
import { Rail } from "../shell/Rail.tsx";
import {
  attachFakeStore,
  makeApproval,
  makeExpertsSession,
  makePlan,
  makeThread,
  makeTurn,
  modelWith,
  resetUi,
} from "../../testHarness.ts";
import { setProvidersForTest } from "../../state/providers.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const project = { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 };

/** One quiet thread, one waiting on an approval, one on a plan. */
function fixture(): ReadModel {
  const model = modelWith({
    projects: { p1: project },
    threads: {
      t1: makeThread("t1", { title: "Quiet thread", updatedAt: 500 }),
      t2: makeThread("t2", { title: "Waiting on approval", attention: "approval", updatedAt: 100 }),
      t3: makeThread("t3", { title: "Plan ready", attention: "plan", updatedAt: 200 }),
    },
  });
  // the plan has waited longer than the approval
  model.activities["a1"] = makeApproval("a1", { threadId: "t2", createdAt: 50 });
  model.plans["pl1"] = makePlan("pl1", { threadId: "t3", createdAt: 10 });
  model.threadTimeline["t1"] = [];
  model.threadTimeline["t2"] = [{ kind: "activity", id: "a1" }];
  model.threadTimeline["t3"] = [{ kind: "plan", id: "pl1" }];
  return model;
}

describe("Mission Control", () => {
  it("heads the page with the scope and the aggregated totals", () => {
    attachFakeStore(fixture());
    render(<MissionControl />);
    expect(screen.getByText("Mission Control")).toBeDefined();
    expect(screen.getByText("All projects")).toBeDefined();
    const totals = screen.getByLabelText("Project totals").textContent ?? "";
    expect(totals).toContain("0 running");
    expect(totals).toContain("2 needs you");
    expect(totals).toContain("3 threads");
  });

  it("renders each waiting item's real card inline, longest-waiting first", () => {
    attachFakeStore(fixture());
    render(<MissionControl />);
    const inbox = within(screen.getByLabelText("Inbox"));
    expect(inbox.getByLabelText("Inbox: Plan ready")).toBeDefined();
    // the approval's own card, not a summary line
    const item = within(inbox.getByLabelText("Inbox: Waiting on approval"));
    expect(item.getByLabelText("Approval: Edit")).toBeDefined();
    expect(item.getByText("Allow")).toBeDefined();
    expect(inbox.getByText("Proposed plan")).toBeDefined();
    const heads = inbox.getAllByText(/Plan ready|Waiting on approval/).map((n) => n.textContent);
    expect(heads).toEqual(["Plan ready", "Waiting on approval"]);
  });

  it("answers an approval from the inbox without opening the thread", () => {
    const fake = attachFakeStore(fixture());
    render(<MissionControl />);
    const item = within(screen.getByLabelText("Inbox: Waiting on approval"));
    fireEvent.click(item.getByText("Allow"));
    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "approval.respond",
      threadId: "t2",
      requestId: "req-a1",
      decision: "accept",
    });
    expect(useUi.getState().view).toBe("mission");
  });

  it("moves the focused inbox card with the arrow keys", () => {
    attachFakeStore(fixture());
    render(<MissionControl />);
    const plan = screen.getByLabelText("Inbox: Plan ready");
    const approval = screen.getByLabelText("Inbox: Waiting on approval");
    const inbox = screen.getByLabelText("Inbox");
    expect(plan.dataset["focused"]).toBe("true");
    // scoped to the inbox: arrows elsewhere on the page do not move it
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(plan.dataset["focused"]).toBe("true");
    fireEvent.keyDown(inbox, { key: "ArrowDown" });
    expect(approval.dataset["focused"]).toBe("true");
    fireEvent.keyDown(inbox, { key: "ArrowUp" });
    expect(plan.dataset["focused"]).toBe("true");
  });

  it("jumps to the thread from an inbox header", () => {
    attachFakeStore(fixture());
    render(<MissionControl />);
    fireEvent.click(screen.getAllByText("jump →")[0] as HTMLElement);
    expect(useUi.getState().selectedThreadId).toBe("t3");
  });

  it("says so quietly when nothing is waiting", () => {
    attachFakeStore(modelWith({ projects: { p1: project }, threads: {} }));
    render(<MissionControl />);
    expect(screen.getByText("Nothing needs you right now.")).toBeDefined();
  });

  it("counts the inbox in the rail", () => {
    attachFakeStore(fixture());
    render(<Rail />);
    const inboxButton = screen.getByText("Inbox").closest("button");
    expect(inboxButton?.textContent).toBe("Inbox2");
  });
});

describe("Mission Control — Now", () => {
  it("lists running threads with model, plan step and elapsed time", () => {
    const model = modelWith({
      projects: { p1: project },
      threads: {
        t1: makeThread("t1", {
          title: "Refactor router",
          status: "running",
          model: "opus-4.6",
          latestTurnId: "u1",
          planProgress: {
            steps: [
              { text: "read the router", status: "completed" },
              { text: "split the table", status: "in_progress" },
            ],
            updatedAt: 1,
          },
        }),
        t2: makeThread("t2", { title: "Idle thread" }),
      },
    });
    model.turns["u1"] = makeTurn("u1", { status: "running", startedAt: Date.now() - 65_000 });
    const fake = attachFakeStore(model);
    render(<MissionControl />);
    const now = within(screen.getByLabelText("Now"));
    expect(now.getByText("Refactor router")).toBeDefined();
    expect(now.getByText(/Tide · Claude Code · opus-4.6/)).toBeDefined();
    expect(now.getByText("split the table")).toBeDefined();
    expect(now.getByText(/^1:0\d$/)).toBeDefined();
    expect(now.queryByText("Idle thread")).toBeNull();

    fireEvent.click(now.getByLabelText("Stop Refactor router"));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "turn.interrupt", threadId: "t1" });
  });

  it("stays hidden when nothing is running", () => {
    attachFakeStore(fixture());
    render(<MissionControl />);
    expect(screen.queryByLabelText("Now")).toBeNull();
  });
});

describe("Mission Control — projects", () => {
  it("shows counts, PR chips, recent threads and the experts sessions", () => {
    const model = modelWith({
      projects: { p1: project },
      threads: {
        t1: makeThread("t1", { title: "Newest", updatedAt: 900, totalCostUsd: 2, status: "running" }),
        t2: makeThread("t2", {
          title: "With a PR",
          updatedAt: 800,
          pr: { url: "https://x/1", number: 1, state: "open", updatedAt: 1 },
        }),
        t3: makeThread("t3", { title: "Older", updatedAt: 700 }),
        t4: makeThread("t4", { title: "Oldest", updatedAt: 1 }),
      },
      expertsSessions: { x1: makeExpertsSession("x1", { topic: "Shard the index" }) },
    });
    attachFakeStore(model);
    render(<MissionControl />);
    const card = within(screen.getByLabelText("Project Tide"));
    expect(card.getByText("/src/tide")).toBeDefined();
    expect(card.getByText("4 threads")).toBeDefined();
    expect(card.getByText("1 running")).toBeDefined();
    expect(card.getByText("⇡ 1 open")).toBeDefined();
    expect(card.getByText("Newest")).toBeDefined();
    expect(card.getByText("Older")).toBeDefined();
    expect(card.queryByText("Oldest")).toBeNull();
    // the project's experts sessions hang off its card, with the phase
    const experts = within(card.getByLabelText("Experts — Tide"));
    expect(experts.getByText("Shard the index")).toBeDefined();
    expect(experts.getByText("Exploring")).toBeDefined();

    fireEvent.click(card.getByText("Newest"));
    expect(useUi.getState().selectedThreadId).toBe("t1");
  });

  it("opens the new-thread popover and the All threads list from the card", () => {
    attachFakeStore(fixture());
    render(<MissionControl />);
    const card = within(screen.getByLabelText("Project Tide"));
    fireEvent.click(card.getByText("New thread"));
    expect(screen.getByText("Create thread")).toBeDefined();

    fireEvent.click(card.getByLabelText("All threads in Tide"));
    expect(useUi.getState().view).toBe("threads");
    expect(useUi.getState().allThreadsProjectId).toBe("p1");
  });

  it("raises the experts dialog from the card", () => {
    attachFakeStore(fixture());
    render(<MissionControl />);
    fireEvent.click(within(screen.getByLabelText("Project Tide")).getByText("Experts"));
    expect(useUi.getState().newExpertsProjectId).toBe("p1");
  });
});

describe("Mission Control — providers", () => {
  const caps = {
    planMode: true,
    subagents: true,
    mcp: true,
    images: true,
    resume: true,
    contextUsage: true,
    openInTerminal: true,
  };

  it("shows ready / not logged in / not installed and offers the login command", () => {
    attachFakeStore(fixture());
    setProvidersForTest([
      { kind: "claude", installed: true, loggedIn: true, models: [], caps },
      {
        kind: "codex",
        installed: true,
        loggedIn: false,
        hint: "Run `codex login`",
        models: [],
        caps,
      },
      { kind: "opencode", installed: false, loggedIn: false, models: [], caps },
      { kind: "pi", installed: true, loggedIn: true, models: [], caps },
    ]);
    render(<MissionControl />);
    const strip = within(screen.getByLabelText("Providers"));
    expect(strip.getByLabelText("Claude Code: ready")).toBeDefined();
    expect(strip.getByLabelText("Codex: not logged in")).toBeDefined();
    expect(strip.getByLabelText("OpenCode: not installed")).toBeDefined();
    expect(strip.getByText("Run codex login")).toBeDefined();

    fireEvent.click(strip.getByLabelText("Claude Code: ready"));
    expect(useUi.getState().view).toBe("settings");
    expect(useUi.getState().settingsSection).toBe("providers");
  });

  it("shows the worst rate limit across a provider's threads, attention-coloured when limited", () => {
    const model = fixture();
    model.threads["t1"] = { ...model.threads["t1"]!, rateLimit: { status: "warning", remainingPct: 20, at: 1 } };
    model.threads["t2"] = {
      ...model.threads["t2"]!,
      rateLimit: { status: "limited", resetsAt: Date.now() + 90 * 60_000, note: "5-hour limit", at: 2 },
    };
    attachFakeStore(model);
    setProvidersForTest([{ kind: "claude", installed: true, loggedIn: true, models: [], caps }]);
    render(<MissionControl />);
    const strip = within(screen.getByLabelText("Providers"));
    const badge = strip.getByLabelText(/rate limit limited/);
    expect(badge.textContent).toBe("⛔ limited · resets in 2h");
    expect(badge.getAttribute("title")).toContain("5-hour limit");
    expect(strip.getAllByLabelText(/rate limit/)).toHaveLength(1);
  });
});
