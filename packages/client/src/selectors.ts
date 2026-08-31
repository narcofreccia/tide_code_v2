import type {
  Activity,
  ActivityOf,
  AttentionKind,
  ExpertsFinding,
  ExpertsMessage,
  ExpertsSession,
  LinkAccess,
  Message,
  Project,
  ProjectLink,
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

// ---- turns / checkpoints ----

/** Turns of a thread in request order (oldest first). */
export function selectThreadTurns(model: ReadModel, threadId: string): Turn[] {
  return Object.values(model.turns)
    .filter((t) => t.threadId === threadId)
    .sort((a, b) => a.requestedAt - b.requestedAt || a.id.localeCompare(b.id));
}

/** Turns that recorded a checkpoint — the ones a diff can be shown for. */
export function selectCheckpointTurns(model: ReadModel, threadId: string): Turn[] {
  return selectThreadTurns(model, threadId).filter((t) => t.checkpoint !== undefined);
}

/** The prompt that opened a turn; used to label it in the turn selector. */
export function selectTurnPrompt(model: ReadModel, threadId: string, turnId: string): string | undefined {
  for (const id of model.threadMessages[threadId] ?? []) {
    const message = model.messages[id];
    if (message && message.turnId === turnId && message.role === "user") return message.text;
  }
  for (const message of Object.values(model.messages)) {
    if (message.turnId === turnId && message.role === "user") return message.text;
  }
  return undefined;
}

// ---- experts ----

/** Non-archived experts sessions, newest first (optionally one project's). */
export function selectExpertsSessions(model: ReadModel, projectId?: string): ExpertsSession[] {
  return Object.values(model.expertsSessions)
    .filter((s) => s.phase !== "archived")
    .filter((s) => projectId === undefined || s.projectId === projectId)
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}

/** Everything the Experts board renders, with dangling references dropped. */
export interface ExpertsBoard {
  session: ExpertsSession;
  findings: ExpertsFinding[];
  messages: ExpertsMessage[];
  /** expert key → its thread, absent until `experts.start` binds one */
  expertThreads: Record<string, Thread | undefined>;
  leadThread: Thread | undefined;
}

/** The board for one session, or undefined when the session is unknown. */
export function selectExpertsBoard(model: ReadModel, sessionId: string): ExpertsBoard | undefined {
  const session = model.expertsSessions[sessionId];
  if (!session) return undefined;
  const findings: ExpertsFinding[] = [];
  for (const id of session.findingIds) {
    const finding = model.expertsFindings[id];
    if (finding) findings.push(finding);
  }
  const messages: ExpertsMessage[] = [];
  for (const id of session.messageIds) {
    const message = model.expertsMessages[id];
    if (message) messages.push(message);
  }
  const expertThreads: Record<string, Thread | undefined> = {};
  for (const expert of session.experts) {
    expertThreads[expert.key] = expert.threadId ? model.threads[expert.threadId] : undefined;
  }
  return {
    session,
    findings,
    messages,
    expertThreads,
    leadThread: session.lead.threadId ? model.threads[session.lead.threadId] : undefined,
  };
}

/** Threads this thread spawned via `tide_delegate`, oldest first. */
export function selectDelegates(model: ReadModel, threadId: string): Thread[] {
  return Object.values(model.threads)
    .filter((t) => t.delegatedBy === threadId && t.archivedAt === undefined)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

// ---- glass-box totals (P6) ----

/** Compact per-project numbers for the Mission Control totals strip. */
export interface ProjectTotals {
  threads: number;
  running: number;
  needsYou: number;
  /** summed `totalCostUsd` of threads touched today */
  costTodayUsd: number;
  /** highest context usage across the project's threads; percentages don't add up */
  maxContextPercent?: number;
}

function isSameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
  );
}

/**
 * Totals over a project's non-archived threads. `now` is injectable so the
 * "today" window is testable. Context is reported as the max, never a sum.
 */
export function selectProjectTotals(model: ReadModel, projectId: string, now = Date.now()): ProjectTotals {
  const threads = Object.values(model.threads).filter(
    (t) => t.projectId === projectId && t.archivedAt === undefined,
  );
  let running = 0;
  let needsYou = 0;
  let costTodayUsd = 0;
  let maxContextPercent: number | undefined;
  for (const thread of threads) {
    if (thread.status === "running") running += 1;
    if (thread.attention !== undefined) needsYou += 1;
    if (thread.totalCostUsd !== undefined && isSameDay(thread.updatedAt, now)) {
      costTodayUsd += thread.totalCostUsd;
    }
    const context = thread.contextUsage;
    if (context && context.window > 0) {
      const percent = Math.round((context.used / context.window) * 100);
      if (maxContextPercent === undefined || percent > maxContextPercent) maxContextPercent = percent;
    }
  }
  return {
    threads: threads.length,
    running,
    needsYou,
    costTodayUsd,
    ...(maxContextPercent === undefined ? {} : { maxContextPercent }),
  };
}

// ---- Mission Control ----

/** A thread with a turn in flight, plus when that turn started. */
export interface RunningThread {
  thread: Thread;
  /** `startedAt` of the active turn, falling back to when it was requested */
  startedAt: number;
  turn: Turn;
}

/**
 * Threads with a turn in flight, longest-running first — the "Now" strip. Expert
 * and delegate threads are included: they are real work happening right now.
 */
export function selectRunningThreads(model: ReadModel, projectId?: string): RunningThread[] {
  const out: RunningThread[] = [];
  for (const thread of Object.values(model.threads)) {
    if (thread.archivedAt !== undefined) continue;
    if (projectId !== undefined && thread.projectId !== projectId) continue;
    if (thread.status !== "running") continue;
    const turn = selectActiveTurn(model, thread.id);
    if (!turn) continue;
    out.push({ thread, turn, startedAt: turn.startedAt ?? turn.requestedAt });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt || a.thread.id.localeCompare(b.thread.id));
}

/**
 * The project's `limit` most recently touched top-level threads. Expert / lead /
 * delegate threads are left out; they belong to their session or caller.
 */
export function selectRecentThreads(model: ReadModel, projectId: string, limit = 3): Thread[] {
  return Object.values(model.threads)
    .filter((t) => t.projectId === projectId && t.archivedAt === undefined && t.role === undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/** How many of the project's threads carry a PR, by state. */
export interface PrCounts {
  open: number;
  merged: number;
  closed: number;
}

export function selectPrCounts(model: ReadModel, projectId: string): PrCounts {
  const counts: PrCounts = { open: 0, merged: 0, closed: 0 };
  for (const thread of Object.values(model.threads)) {
    if (thread.projectId !== projectId || thread.archivedAt !== undefined) continue;
    if (thread.pr) counts[thread.pr.state] += 1;
  }
  return counts;
}

// ---- linked repositories (W1) ----

/** A thread's link with the project link it points at, already resolved. */
export interface ResolvedThreadLink {
  link: ProjectLink;
  /** the access this thread was created with, which may narrow the project default */
  access: LinkAccess;
}

const NO_LINKS: ProjectLink[] = [];

/** A project's linked repositories in stored order; `[]` when it has none. */
export function selectProjectLinks(model: ReadModel, projectId: string): ProjectLink[] {
  return model.projects[projectId]?.links ?? NO_LINKS;
}

/**
 * The linked repos a thread can reach, with dangling ids dropped. A thread with
 * no explicit `links` inherits the project's, each at its default access — the
 * same rule `thread.create` applies when `links` is omitted.
 */
export function selectThreadLinks(model: ReadModel, threadId: string): ResolvedThreadLink[] {
  const thread = model.threads[threadId];
  if (!thread) return [];
  const links = selectProjectLinks(model, thread.projectId);
  if (thread.links === undefined) return links.map((link) => ({ link, access: link.access }));
  const out: ResolvedThreadLink[] = [];
  for (const entry of thread.links) {
    const link = links.find((l) => l.id === entry.linkId);
    if (link) out.push({ link, access: entry.access });
  }
  return out;
}
