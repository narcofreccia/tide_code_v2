import type {
  Activity,
  ActivityOf,
  AttentionKind,
  Message,
  Project,
  ProposedPlan,
  ReadModel,
  Thread,
  Turn,
} from "@tide/contracts";

/** Non-archived projects, alphabetical by title (stable via id tiebreak). */
export function selectProjects(model: ReadModel): Project[] {
  return Object.values(model.projects)
    .filter((p) => p.archivedAt === undefined)
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

/** Non-archived threads of a project, newest first. */
export function selectThreadsByProject(model: ReadModel, projectId: string): Thread[] {
  return Object.values(model.threads)
    .filter((t) => t.projectId === projectId && t.archivedAt === undefined)
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}

/** Messages of a thread in arrival order. */
export function selectThreadMessages(model: ReadModel, threadId: string): Message[] {
  const ids = model.threadMessages[threadId] ?? [];
  const out: Message[] = [];
  for (const id of ids) {
    const m = model.messages[id];
    if (m) out.push(m);
  }
  return out;
}

// ---- timeline ----

/** A timeline entry with its referenced entity resolved. */
export type TimelineItem =
  | { kind: "message"; message: Message }
  | { kind: "activity"; activity: Activity }
  | { kind: "plan"; plan: ProposedPlan };

/**
 * The thread's chronological stream (messages, activities, plans) with dangling
 * references dropped. Falls back to `threadMessages` when the thread has no
 * timeline yet, so message-only models still render.
 */
export function selectTimeline(model: ReadModel, threadId: string): TimelineItem[] {
  const entries = model.threadTimeline[threadId];
  if (entries === undefined) {
    return selectThreadMessages(model, threadId).map((message) => ({ kind: "message" as const, message }));
  }
  const out: TimelineItem[] = [];
  for (const entry of entries) {
    if (entry.kind === "message") {
      const message = model.messages[entry.id];
      if (message) out.push({ kind: "message", message });
    } else if (entry.kind === "activity") {
      const activity = model.activities[entry.id];
      if (activity) out.push({ kind: "activity", activity });
    } else {
      const plan = model.plans[entry.id];
      if (plan) out.push({ kind: "plan", plan });
    }
  }
  return out;
}

/** The turn currently in flight for a thread, if any. */
export function selectActiveTurn(model: ReadModel, threadId: string): Turn | undefined {
  const thread = model.threads[threadId];
  const turn = thread?.latestTurnId ? model.turns[thread.latestTurnId] : undefined;
  if (!turn) return undefined;
  return turn.status === "requested" || turn.status === "running" ? turn : undefined;
}

// ---- attention / inbox ----

/** Needs-you threads before the rest, then most recently updated first. */
export function compareByAttention(a: Thread, b: Thread): number {
  const rank = (t: Thread): number => (t.attention ? 0 : 1);
  return rank(a) - rank(b) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
}

/** Non-archived threads whose projector-derived `attention` is set. */
export function selectThreadsNeedingAttention(model: ReadModel, projectId?: string): Thread[] {
  return Object.values(model.threads)
    .filter((t) => t.archivedAt === undefined && t.attention !== undefined)
    .filter((t) => projectId === undefined || t.projectId === projectId)
    .sort(compareByAttention);
}

/** One inbox row: the thread plus the thing that is waiting on the user. */
export interface InboxItem {
  thread: Thread;
  attention: AttentionKind;
  /** the pending approval / user-input activity behind `attention` */
  activity?: ActivityOf<"approval"> | ActivityOf<"user-input">;
  /** the proposed plan behind `attention` */
  plan?: ProposedPlan;
}

function pendingActivity(
  model: ReadModel,
  threadId: string,
  kind: "approval" | "user-input",
): ActivityOf<"approval"> | ActivityOf<"user-input"> | undefined {
  for (const entry of model.threadTimeline[threadId] ?? []) {
    if (entry.kind !== "activity") continue;
    const a = model.activities[entry.id];
    if (a && a.kind === kind && a.status === "pending") return a;
  }
  return undefined;
}

function proposedPlan(model: ReadModel, threadId: string): ProposedPlan | undefined {
  for (const entry of model.threadTimeline[threadId] ?? []) {
    if (entry.kind !== "plan") continue;
    const p = model.plans[entry.id];
    if (p && p.status === "proposed") return p;
  }
  return undefined;
}

/** Everything waiting on the user, needs-you first then most recent. */
export function selectInbox(model: ReadModel, projectId?: string): InboxItem[] {
  const out: InboxItem[] = [];
  for (const thread of selectThreadsNeedingAttention(model, projectId)) {
    const attention = thread.attention;
    if (attention === undefined) continue;
    if (attention === "plan") {
      const plan = proposedPlan(model, thread.id);
      out.push({ thread, attention, ...(plan ? { plan } : {}) });
      continue;
    }
    const activity = pendingActivity(model, thread.id, attention === "approval" ? "approval" : "user-input");
    out.push({ thread, attention, ...(activity ? { activity } : {}) });
  }
  return out;
}

// ---- activity grouping ----

/** A timeline item after consecutive settled tool calls have been collapsed. */
export type TimelineNode =
  | TimelineItem
  | { kind: "group"; id: string; parentToolUseId?: string; activities: ActivityOf<"tool">[] };

/** Runs shorter than this stay as individual rows. */
const MIN_GROUP = 3;

/**
 * Collapses runs of consecutive settled tool activities sharing a
 * `parentToolUseId` into one group ("read 4 files"). Pure; a running tool or any
 * other entry kind breaks the run so live rows stay visible.
 */
export function groupActivities(entries: readonly TimelineItem[]): TimelineNode[] {
  const out: TimelineNode[] = [];
  let run: ActivityOf<"tool">[] = [];
  let runParent: string | undefined;

  const flush = (): void => {
    const first = run[0];
    if (first && run.length >= MIN_GROUP) {
      out.push({
        kind: "group",
        id: `group:${first.id}`,
        ...(runParent === undefined ? {} : { parentToolUseId: runParent }),
        activities: run,
      });
    } else {
      for (const activity of run) out.push({ kind: "activity", activity });
    }
    run = [];
    runParent = undefined;
  };

  for (const entry of entries) {
    if (entry.kind === "activity" && entry.activity.kind === "tool" && entry.activity.status !== "running") {
      const parent = entry.activity.parentToolUseId;
      if (run.length > 0 && parent !== runParent) flush();
      runParent = parent;
      run.push(entry.activity);
      continue;
    }
    flush();
    out.push(entry);
  }
  flush();
  return out;
}
