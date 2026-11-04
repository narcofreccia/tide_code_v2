import { describe, expect, it } from "vitest";
import {
  emptyReadModel,
  type Activity,
  type ActivityOf,
  type Message,
  type ProposedPlan,
  type Project,
  type ProjectLink,
  type ReadModel,
  type Thread,
  type TimelineEntry,
  type Turn,
} from "@tide/contracts";
import {
  descendantThreads,
  groupActivities,
  isSnoozed,
  selectLimited,
  selectLineage,
  selectPrWatch,
  selectRunningThreads,
  selectSnoozed,
  selectRailGroups,
  selectSettled,
  isSettled,
  isMergedSettle,
  selectActiveTurn,
  selectIdleMs,
  selectInbox,
  selectThreadsNeedingAttention,
  selectProjectLinks,
  selectQueuedTurns,
  selectThreadLinks,
  selectTimeline,
  type TimelineItem,
} from "./selectors.ts";

const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({
  id,
  projectId: "p1",
  title: `Thread ${id}`,
  provider: "claude",
  mode: "approval-required",
  interaction: "default",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

const message = (id: string, threadId = "t1"): Message => ({
  id,
  threadId,
  turnId: "u1",
  role: "assistant",
  text: id,
  createdAt: 1,
});

const tool = (id: string, patch: Partial<ActivityOf<"tool">> = {}): ActivityOf<"tool"> => ({
  id,
  threadId: "t1",
  turnId: "u1",
  createdAt: 1,
  updatedAt: 1,
  kind: "tool",
  toolUseId: `use-${id}`,
  toolName: "Read",
  input: { file_path: "/src/a.ts" },
  status: "ok",
  ...patch,
});

const approval = (id: string, patch: Partial<ActivityOf<"approval">> = {}): ActivityOf<"approval"> => ({
  id,
  threadId: "t1",
  turnId: "u1",
  createdAt: 1,
  updatedAt: 1,
  kind: "approval",
  requestId: `req-${id}`,
  toolName: "Edit",
  input: { file_path: "/src/x.ts" },
  status: "pending",
  ...patch,
});

const plan = (id: string, patch: Partial<ProposedPlan> = {}): ProposedPlan => ({
  id,
  threadId: "t1",
  turnId: "u1",
  markdown: "# plan",
  status: "proposed",
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

function build(parts: {
  threads?: Thread[];
  messages?: Message[];
  activities?: Activity[];
  plans?: ProposedPlan[];
  turns?: Turn[];
  timeline?: Record<string, TimelineEntry[]>;
}): ReadModel {
  const model = emptyReadModel();
  for (const t of parts.threads ?? []) {
    model.threads[t.id] = t;
    model.threadTimeline[t.id] = [];
    model.threadMessages[t.id] = [];
  }
  for (const m of parts.messages ?? []) model.messages[m.id] = m;
  for (const a of parts.activities ?? []) model.activities[a.id] = a;
  for (const p of parts.plans ?? []) model.plans[p.id] = p;
  for (const t of parts.turns ?? []) model.turns[t.id] = t;
  for (const [id, entries] of Object.entries(parts.timeline ?? {})) model.threadTimeline[id] = entries;
  return model;
}

const items = (...activities: Activity[]): TimelineItem[] =>
  activities.map((activity) => ({ kind: "activity" as const, activity }));

describe("selectTimeline", () => {
  it("resolves entries in order and drops dangling references", () => {
    const model = build({
      threads: [thread("t1")],
      messages: [message("m1")],
      activities: [tool("a1")],
      plans: [plan("pl1")],
      timeline: {
        t1: [
          { kind: "message", id: "m1" },
          { kind: "activity", id: "a1" },
          { kind: "activity", id: "missing" },
          { kind: "plan", id: "pl1" },
        ],
      },
    });
    expect(selectTimeline(model, "t1").map((e) => e.kind)).toEqual(["message", "activity", "plan"]);
  });

  it("falls back to threadMessages when the thread has no timeline", () => {
    const model = build({ messages: [message("m1")] });
    model.threadMessages["t1"] = ["m1"];
    const out = selectTimeline(model, "t1");
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ kind: "message", message: model.messages["m1"] });
  });
});

describe("selectActiveTurn", () => {
  const turn = (status: Turn["status"]): Turn => ({ id: "u1", threadId: "t1", status, requestedAt: 1 });

  it("returns the latest turn while it is in flight", () => {
    const model = build({ threads: [thread("t1", { latestTurnId: "u1" })], turns: [turn("running")] });
    expect(selectActiveTurn(model, "t1")?.id).toBe("u1");
  });

  it("returns undefined once the turn settled", () => {
    const model = build({ threads: [thread("t1", { latestTurnId: "u1" })], turns: [turn("completed")] });
    expect(selectActiveTurn(model, "t1")).toBeUndefined();
  });
});

describe("selectQueuedTurns", () => {
  const t = (id: string, status: Turn["status"], requestedAt: number): Turn => ({
    id,
    threadId: "t1",
    status,
    requestedAt,
  });

  it("returns only queued turns of the thread, oldest first", () => {
    const model = build({
      threads: [thread("t1"), thread("t2")],
      turns: [
        t("u3", "queued", 30),
        t("u2", "queued", 20),
        t("u1", "running", 10),
        { ...t("u9", "queued", 5), threadId: "t2" },
      ],
    });
    expect(selectQueuedTurns(model, "t1").map((x) => x.id)).toEqual(["u2", "u3"]);
  });

  it("is empty when nothing waits", () => {
    const model = build({ threads: [thread("t1")], turns: [t("u1", "running", 1)] });
    expect(selectQueuedTurns(model, "t1")).toEqual([]);
  });
});

describe("selectThreadsNeedingAttention", () => {
  it("keeps only threads with attention, newest first, and filters by project", () => {
    const model = build({
      threads: [
        thread("t1", { attention: "approval", updatedAt: 10 }),
        thread("t2", { attention: "plan", updatedAt: 20 }),
        thread("t3"),
        thread("t4", { attention: "question", updatedAt: 30, archivedAt: 5 }),
        thread("t5", { projectId: "p2", attention: "question", updatedAt: 40 }),
      ],
    });
    expect(selectThreadsNeedingAttention(model).map((t) => t.id)).toEqual(["t5", "t2", "t1"]);
    expect(selectThreadsNeedingAttention(model, "p1").map((t) => t.id)).toEqual(["t2", "t1"]);
  });
});

describe("selectInbox", () => {
  it("lists every pending card of a thread, not just the first, with the plan", () => {
    const model = build({
      threads: [thread("t1", { attention: "approval", updatedAt: 10 }), thread("t2", { attention: "plan", updatedAt: 20 })],
      activities: [
        approval("a1", { createdAt: 5 }),
        approval("a0", { status: "resolved" }),
        approval("a2", { createdAt: 7 }),
      ],
      plans: [plan("pl1", { threadId: "t2", createdAt: 6 }), plan("pl0", { threadId: "t2", status: "dismissed" })],
      timeline: {
        t1: [
          { kind: "activity", id: "a0" },
          { kind: "activity", id: "a1" },
          { kind: "activity", id: "a2" },
        ],
        t2: [
          { kind: "plan", id: "pl0" },
          { kind: "plan", id: "pl1" },
        ],
      },
    });
    const inbox = selectInbox(model);
    // oldest wait first when nothing is triaged
    expect(inbox.map((i) => i.key)).toEqual(["a1", "pl1", "a2"]);
    expect(inbox.map((i) => i.since)).toEqual([5, 6, 7]);
    expect(inbox[1]?.plan?.id).toBe("pl1");
    expect(inbox[0]?.activity?.id).toBe("a1");
  });

  it("sorts by triage urgency first, then by age, and keeps a bare row for a flag without a card", () => {
    const model = build({
      threads: [
        thread("t1", { attention: "approval" }),
        thread("t2", { attention: "question", triage: { needsUser: 0.9, stuck: 0.1, urgency: 0.8, at: 1 } }),
        thread("t3", { attention: "plan", updatedAt: 3, triage: { needsUser: 0.5, stuck: 0.7, urgency: 0.2, at: 1 } }),
      ],
      activities: [approval("a1", { createdAt: 1 }), approval("q1", { threadId: "t2", createdAt: 9 })],
      timeline: { t1: [{ kind: "activity", id: "a1" }], t2: [{ kind: "activity", id: "q1" }] },
    });
    const inbox = selectInbox(model);
    expect(inbox.map((i) => i.key)).toEqual(["q1", "thread:t3", "a1"]);
    expect(inbox[1]?.attention).toBe("plan");
  });

  it("puts approvals the judge rated consequential first, whatever the urgency", () => {
    const verdict = (label: string) => ({ site: "approvals" as const, label, confidence: 0.9, source: "jev" as const, at: 1 });
    const model = build({
      threads: [
        thread("t1", { attention: "approval" }),
        thread("t2", { attention: "approval", triage: { needsUser: 0.9, stuck: 0.1, urgency: 0.9, at: 1 } }),
        thread("t3", { attention: "approval" }),
      ],
      activities: [
        approval("a1", { createdAt: 1, judge: verdict("routine") }),
        approval("a2", { threadId: "t2", createdAt: 2, judge: verdict("routine") }),
        approval("a3", { threadId: "t3", createdAt: 9, judge: verdict("consequential") }),
      ],
      timeline: { t1: [{ kind: "activity", id: "a1" }], t2: [{ kind: "activity", id: "a2" }], t3: [{ kind: "activity", id: "a3" }] },
    });
    expect(selectInbox(model).map((i) => i.key)).toEqual(["a3", "a2", "a1"]);
  });
});

describe("groupActivities", () => {
  it("collapses three or more consecutive settled tool calls", () => {
    const nodes = groupActivities(items(tool("a1"), tool("a2"), tool("a3")));
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.kind).toBe("group");
  });

  it("leaves short runs as individual rows", () => {
    const nodes = groupActivities(items(tool("a1"), tool("a2")));
    expect(nodes.map((n) => n.kind)).toEqual(["activity", "activity"]);
  });

  it("breaks runs on a running tool, another entry kind, or a different parent", () => {
    const nodes = groupActivities([
      ...items(tool("a1"), tool("a2"), tool("a3", { status: "running" }), tool("a4")),
      { kind: "message", message: message("m1") },
      ...items(
        tool("b1", { parentToolUseId: "child" }),
        tool("b2", { parentToolUseId: "child" }),
        tool("b3", { parentToolUseId: "child" }),
      ),
    ]);
    expect(nodes.map((n) => n.kind)).toEqual([
      "activity",
      "activity",
      "activity",
      "activity",
      "message",
      "group",
    ]);
    const group = nodes[5];
    expect(group?.kind === "group" ? group.parentToolUseId : undefined).toBe("child");
  });
});

describe("linked repositories", () => {
  const link = (id: string, patch: Partial<ProjectLink> = {}): ProjectLink => ({
    id,
    path: `/repo/${id}`,
    label: id,
    access: "write",
    ...patch,
  });

  const withProject = (links: ProjectLink[] | undefined, threads: Thread[] = []): ReadModel => {
    const project: Project = {
      id: "p1",
      title: "api",
      rootPath: "/repo/api",
      createdAt: 1,
      updatedAt: 1,
      ...(links === undefined ? {} : { links }),
    };
    const model = emptyReadModel();
    model.projects[project.id] = project;
    for (const t of threads) model.threads[t.id] = t;
    return model;
  };

  it("returns the project's links, and nothing for an unknown project", () => {
    const model = withProject([link("a"), link("b")]);
    expect(selectProjectLinks(model, "p1").map((l) => l.id)).toEqual(["a", "b"]);
    expect(selectProjectLinks(model, "nope")).toEqual([]);
    expect(selectProjectLinks(withProject(undefined), "p1")).toEqual([]);
  });

  it("resolves a thread's explicit links, keeping its own access", () => {
    const model = withProject(
      [link("a"), link("b", { access: "read" })],
      [thread("t1", { links: [{ linkId: "b", access: "write" }] })],
    );
    expect(selectThreadLinks(model, "t1")).toEqual([
      { link: link("b", { access: "read" }), access: "write" },
    ]);
  });

  it("inherits every project link at its default access when the thread has none", () => {
    const model = withProject([link("a"), link("b", { access: "read" })], [thread("t1")]);
    expect(selectThreadLinks(model, "t1").map((r) => [r.link.id, r.access])).toEqual([
      ["a", "write"],
      ["b", "read"],
    ]);
  });

  it("drops links the project no longer has, and unknown threads", () => {
    const model = withProject([link("a")], [thread("t1", { links: [{ linkId: "gone", access: "read" }] })]);
    expect(selectThreadLinks(model, "t1")).toEqual([]);
    expect(selectThreadLinks(model, "t404")).toEqual([]);
  });
});

describe("R4 selectors", () => {
  const models = (threads: Thread[]): ReadModel => ({
    ...emptyReadModel(),
    threads: Object.fromEntries(threads.map((t) => [t.id, t])),
  });

  it("selectLimited sorts by resetsAt, unknown last", () => {
    const lim = (resetsAt?: number) => ({ resume: "manual" as const, at: 1, ...(resetsAt ? { resetsAt } : {}) });
    const m = models([
      thread("a", { limited: lim() }),
      thread("b", { limited: lim(50) }),
      thread("c", { limited: lim(10) }),
      thread("d"),
    ]);
    expect(selectLimited(m).map((t) => t.id)).toEqual(["c", "b", "a"]);
  });

  it("snooze: isSnoozed, selectSnoozed, hidden from the inbox until it lapses", () => {
    const t = thread("s", { attention: "approval", snoozedUntil: 100 });
    expect(isSnoozed(t, 50)).toBe(true);
    expect(isSnoozed(t, 100)).toBe(false);
    const m = models([t]);
    expect(selectSnoozed(m, 50).map((x) => x.id)).toEqual(["s"]);
    expect(selectSnoozed(m, 150)).toEqual([]);
    expect(selectInbox(m, undefined, 50)).toEqual([]);
    expect(selectInbox(m, undefined, 150).map((i) => i.thread.id)).toEqual(["s"]);
  });

  it("snoozed running threads leave the Now strip", () => {
    const m = models([thread("r", { status: "running", snoozedUntil: 100, latestTurnId: "u1" })]);
    m.turns["u1"] = { id: "u1", threadId: "r", status: "running", requestedAt: 1 } as Turn;
    expect(selectRunningThreads(m, undefined, 50)).toEqual([]);
    expect(selectRunningThreads(m, undefined, 150)).toHaveLength(1);
  });

  it("inbox rows carry the latest turn's notification summary", () => {
    const m = models([thread("n", { attention: "question", latestTurnId: "u1" })]);
    m.messages["m1"] = { ...message("m1", "n"), notification: { source: "pr", summary: "CI failed" } };
    m.threadMessages["n"] = ["m1"];
    expect(selectInbox(m)[0]?.notification).toBe("CI failed");
  });

  it("selectPrWatch and selectLineage", () => {
    const pr = { number: 3, url: "u", state: "open" as const };
    const m = models([
      thread("w", { prWatch: { since: 1 }, pr } as Partial<Thread>),
      thread("x", { pr } as Partial<Thread>),
      thread("src"),
      thread("f1", { forkedFrom: { threadId: "src", turnId: "u1" }, createdAt: 2 }),
    ]);
    expect(selectPrWatch(m).map((e) => e.thread.id)).toEqual(["w"]);
    const l = selectLineage(m, "src");
    expect(l.forks.map((t) => t.id)).toEqual(["f1"]);
    expect(selectLineage(m, "f1").source?.id).toBe("src");
  });
});

describe("selectRailGroups", () => {
  const rail = (threads: Thread[]): ReadModel => {
    const m = emptyReadModel();
    for (const t of threads) m.threads[t.id] = t;
    return m;
  };
  const ids = (ts: Thread[]): string[] => ts.map((t) => t.id);

  it("puts pinned threads in their own group at the top", () => {
    const m = rail([thread("a", { updatedAt: 5 }), thread("b", { pinned: true, updatedAt: 1 })]);
    const g = selectRailGroups(m, "p1", 0);
    expect(ids(g.pinned)).toEqual(["b"]);
    expect(ids(g.threads)).toEqual(["a"]);
  });

  it("collects snoozed threads, even pinned ones, until the snooze lapses", () => {
    const m = rail([thread("s", { pinned: true, snoozedUntil: 100 }), thread("t")]);
    expect(ids(selectRailGroups(m, "p1", 50).snoozed)).toEqual(["s"]);
    expect(ids(selectRailGroups(m, "p1", 50).pinned)).toEqual([]);
    expect(ids(selectRailGroups(m, "p1", 150).pinned)).toEqual(["s"]);
  });

  it("collects archived threads, ahead of snooze and pin", () => {
    const m = rail([thread("x", { archivedAt: 9, pinned: true, snoozedUntil: 100 }), thread("y")]);
    const g = selectRailGroups(m, "p1", 50);
    expect(ids(g.archived)).toEqual(["x"]);
    expect(g.snoozed).toEqual([]);
    expect(ids(g.threads)).toEqual(["y"]);
  });

  it("keeps compareByAttention order inside each group and ignores other projects", () => {
    const m = rail([
      thread("old", { updatedAt: 1 }),
      thread("new", { updatedAt: 3 }),
      thread("asks", { updatedAt: 0, attention: "approval" }),
      thread("other", { projectId: "p2" }),
    ]);
    expect(ids(selectRailGroups(m, "p1", 0).threads)).toEqual(["asks", "new", "old"]);
  });

  it("moves settled threads to their own group, newest settle first", () => {
    const m = rail([
      thread("a", { settledAt: 10, settleReason: "user" }),
      thread("b", { settledAt: 20, settleReason: "pr-merged", pinned: true }),
      thread("c"),
    ]);
    const g = selectRailGroups(m, "p1", 0);
    expect(ids(g.settled)).toEqual(["b", "a"]);
    expect(g.pinned).toEqual([]);
    expect(ids(g.threads)).toEqual(["c"]);
    expect(ids(selectSettled(m))).toEqual(["b", "a"]);
    expect(isSettled(m.threads.c!)).toBe(false);
  });

  it("snoozed and archived win over settled", () => {
    const m = rail([thread("s", { settledAt: 1, snoozedUntil: 100 }), thread("x", { settledAt: 1, archivedAt: 2 })]);
    const g = selectRailGroups(m, "p1", 50);
    expect(ids(g.snoozed)).toEqual(["s"]);
    expect(ids(g.archived)).toEqual(["x"]);
    expect(g.settled).toEqual([]);
    expect(ids(selectSettled(m))).toEqual(["s"]);
  });

  it("puts running, unpinned threads under Working only when the section is on", () => {
    const m = rail([
      thread("run", { status: "running" }),
      thread("runPinned", { status: "running", pinned: true }),
      thread("idle"),
    ]);
    expect(selectRailGroups(m, "p1", 0).working).toEqual([]);
    const g = selectRailGroups(m, "p1", 0, { workingSection: true });
    expect(ids(g.working)).toEqual(["run"]);
    expect(ids(g.pinned)).toEqual(["runPinned"]);
    expect(ids(g.threads)).toEqual(["idle"]);
  });

  it("never lists a settled thread as needing attention", () => {
    const m = rail([thread("a", { attention: "approval", settledAt: 5 }), thread("b", { attention: "approval" })]);
    expect(ids(selectThreadsNeedingAttention(m))).toEqual(["b"]);
  });
});

describe("descendantThreads", () => {
  it("collects forks and delegates transitively, archived included, cycle-safe", () => {
    const model = emptyReadModel();
    for (const t of [
      thread("root"),
      thread("fork", { parentThreadId: "root" }),
      thread("deleg", { delegatedBy: "fork", archivedAt: 5 }),
      thread("other"),
      thread("loop", { parentThreadId: "deleg" }),
    ]) model.threads[t.id] = t;
    model.threads["root"] = { ...model.threads["root"]!, parentThreadId: "loop" };
    const ids = descendantThreads(model, "root").map((t) => t.id).sort();
    expect(ids).toEqual(["deleg", "fork", "loop"]);
    expect(descendantThreads(model, "other")).toEqual([]);
  });
});

describe("selectIdleMs", () => {
  const thread = { id: "t1", projectId: "p1", title: "T", provider: "claude", mode: "approval-required", interaction: "default", status: "running", createdAt: 100, updatedAt: 9_000, latestTurnId: "u1" } as Thread;
  it("measures from the latest message, activity or turn time, ignoring updatedAt", () => {
    const model: ReadModel = {
      ...emptyReadModel(),
      threads: { t1: thread },
      messages: { m1: { id: "m1", threadId: "t1", turnId: "u1", role: "user", text: "go", createdAt: 200 } },
      threadMessages: { t1: ["m1"] },
      activities: { a1: { id: "a1", threadId: "t1", turnId: "u1", kind: "info", text: "x", createdAt: 300, updatedAt: 1_000 } as Activity },
      threadTimeline: { t1: [{ kind: "message", id: "m1" }, { kind: "activity", id: "a1" }] as TimelineEntry[] },
      turns: { u1: { id: "u1", threadId: "t1", status: "running", requestedAt: 200, startedAt: 250 } },
    };
    expect(selectIdleMs(model, thread, 61_000)).toBe(60_000);
    const { latestTurnId: _drop, ...fresh } = thread;
    expect(selectIdleMs({ ...emptyReadModel(), threads: { t1: fresh } }, fresh, 50)).toBe(0);
  });
});

describe("isMergedSettle", () => {
  const t = (patch: Partial<Thread>): Thread => ({ id: "x", ...patch }) as Thread;
  it("is true only for settled threads settled by a merge", () => {
    expect(isMergedSettle(t({ settledAt: 1, settleReason: "merged-back" }))).toBe(true);
    expect(isMergedSettle(t({ settledAt: 1, settleReason: "pr-merged" }))).toBe(true);
    expect(isMergedSettle(t({ settledAt: 1, settleReason: "user" }))).toBe(false);
    expect(isMergedSettle(t({ settleReason: "merged-back" }))).toBe(false);
    expect(isMergedSettle(t({ mergedAt: 1 }))).toBe(false);
  });
});
