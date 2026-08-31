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
  groupActivities,
  selectActiveTurn,
  selectInbox,
  selectThreadsNeedingAttention,
  selectProjectLinks,
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
  it("attaches the pending approval and the proposed plan", () => {
    const model = build({
      threads: [thread("t1", { attention: "approval", updatedAt: 10 }), thread("t2", { attention: "plan", updatedAt: 20 })],
      activities: [approval("a1"), approval("a0", { status: "resolved" })],
      plans: [plan("pl1", { threadId: "t2" }), plan("pl0", { threadId: "t2", status: "dismissed" })],
      timeline: {
        t1: [
          { kind: "activity", id: "a0" },
          { kind: "activity", id: "a1" },
        ],
        t2: [
          { kind: "plan", id: "pl0" },
          { kind: "plan", id: "pl1" },
        ],
      },
    });
    const inbox = selectInbox(model);
    expect(inbox.map((i) => i.thread.id)).toEqual(["t2", "t1"]);
    expect(inbox[0]?.plan?.id).toBe("pl1");
    expect(inbox[1]?.activity?.id).toBe("a1");
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
