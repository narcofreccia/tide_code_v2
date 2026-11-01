import type {
  Activity,
  ActivityOf,
  ExpertsFinding,
  ExpertsMessage,
  ExpertsSession,
  LinkAccess,
  Message,
  Project,
  ProjectLink,
  ProposedPlan,
  ReadModel,
  ScheduledTask,
  TeamStage,
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

/** True while the thread's snooze is still in the future. */
export function isSnoozed(thread: Thread, now: number = Date.now()): boolean {
  return thread.snoozedUntil !== undefined && thread.snoozedUntil > now;
}

/** Snoozed, non-archived threads, waking soonest first. */
export function selectSnoozed(model: ReadModel, now: number = Date.now()): Thread[] {
  return Object.values(model.threads)
    .filter((t) => t.archivedAt === undefined && isSnoozed(t, now))
    .sort((a, b) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0) || a.id.localeCompare(b.id));
}

/** Threads that hit a usage limit, earliest reset first (unknown reset last). */
export function selectLimited(model: ReadModel): Thread[] {
  return Object.values(model.threads)
    .filter((t) => t.archivedAt === undefined && t.limited !== undefined)
    .sort(
      (a, b) =>
        (a.limited?.resetsAt ?? Infinity) - (b.limited?.resetsAt ?? Infinity) || a.id.localeCompare(b.id),
    );
}

/** Threads whose PR is being polled, with the fields the pill shows. */
export interface PrWatched {
  thread: Thread;
  pr: NonNullable<Thread["pr"]>;
}
export function selectPrWatch(model: ReadModel): PrWatched[] {
  const out: PrWatched[] = [];
  for (const thread of Object.values(model.threads)) {
    if (thread.archivedAt !== undefined || thread.prWatch === undefined || thread.pr === undefined) continue;
    out.push({ thread, pr: thread.pr });
  }
  return out.sort((a, b) => a.thread.id.localeCompare(b.thread.id));
}

/** The thread this one was forked from, and the threads forked from it. */
export function selectLineage(model: ReadModel, threadId: string): { source?: Thread; forks: Thread[] } {
  const sourceId = model.threads[threadId]?.forkedFrom?.threadId;
  const source = sourceId === undefined ? undefined : model.threads[sourceId];
  const forks = Object.values(model.threads)
    .filter((t) => t.forkedFrom?.threadId === threadId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return { ...(source ? { source } : {}), forks };
}

/** Needs-you threads before the rest, then most recently updated first. */
export function compareByAttention(a: Thread, b: Thread): number {
  const rank = (t: Thread): number => (t.attention ? 0 : 1);
  return rank(a) - rank(b) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
}

/** One project's threads as the rail groups them. */
export interface RailGroups {
  /** pinned, not snoozed, not settled: kept at the top */
  pinned: Thread[];
  /** everything else that is live: the inbox */
  threads: Thread[];
  /** running and not pinned, only when the Working section is on; collapsed under "Working · n" */
  working: Thread[];
  /** snoozed until later; collapsed under "Snoozed · n" */
  snoozed: Thread[];
  /** settled (closed from the inbox, worktree kept), most recently settled first */
  settled: Thread[];
  /** archived; collapsed under "Archived · n", open read-only */
  archived: Thread[];
}

export interface RailGroupOptions {
  /** `settings.inbox.workingSection`: running, unpinned threads leave the inbox for "Working" */
  workingSection?: boolean;
}

/** R7: closed from the inbox; the projector clears it on a new turn or when the thread needs the user. */
export function isSettled(thread: Thread): boolean {
  return thread.settledAt !== undefined;
}

function bySettledDesc(a: Thread, b: Thread): number {
  return (b.settledAt ?? 0) - (a.settledAt ?? 0) || a.id.localeCompare(b.id);
}

/** Settled, non-archived threads, most recently settled first. */
export function selectSettled(model: ReadModel, projectId?: string): Thread[] {
  return Object.values(model.threads)
    .filter((t) => t.archivedAt === undefined && isSettled(t))
    .filter((t) => projectId === undefined || t.projectId === projectId)
    .sort(bySettledDesc);
}

/**
 * The rail's groups for one project. Archived wins over snoozed, snoozed over
 * settled, settled over pinned, pinned over working; each group keeps
 * `compareByAttention` order except settled (newest settle first).
 */
export function selectRailGroups(
  model: ReadModel,
  projectId: string,
  now: number = Date.now(),
  opts: RailGroupOptions = {},
): RailGroups {
  const groups: RailGroups = { pinned: [], threads: [], working: [], snoozed: [], settled: [], archived: [] };
  for (const thread of Object.values(model.threads)) {
    if (thread.projectId !== projectId) continue;
    if (thread.archivedAt !== undefined) groups.archived.push(thread);
    else if (isSnoozed(thread, now)) groups.snoozed.push(thread);
    else if (isSettled(thread)) groups.settled.push(thread);
    else if (thread.pinned === true) groups.pinned.push(thread);
    else if (opts.workingSection === true && thread.status === "running" && thread.attention === undefined) groups.working.push(thread);
    else groups.threads.push(thread);
  }
  groups.pinned.sort(compareByAttention);
  groups.threads.sort(compareByAttention);
  groups.working.sort(compareByAttention);
  groups.snoozed.sort(compareByAttention);
  groups.settled.sort(bySettledDesc);
  groups.archived.sort(compareByAttention);
  return groups;
}

/** Non-archived threads whose projector-derived `attention` is set. */
export function selectThreadsNeedingAttention(
  model: ReadModel,
  projectId?: string,
  now: number = Date.now(),
): Thread[] {
  return Object.values(model.threads)
    .filter((t) => t.archivedAt === undefined && t.attention !== undefined && !isSnoozed(t, now) && !isSettled(t))
    .filter((t) => projectId === undefined || t.projectId === projectId)
    .sort(compareByAttention);
}

// selectInbox / InboxItem live in inboxSelectors.ts (re-exported below)

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

/**
 * Caches `compute(map, key)` per map object. The projector replaces a map only when
 * something in it changed, so while `model.turns` / `model.threads` keep their identity
 * (every streaming delta) the derived value comes back as is: same identity, no scan.
 * The WeakMap lets old maps and their cache entries go with the model that held them.
 */
export function memoByRef<M extends object, R>(compute: (map: M, key: string) => R): (map: M, key: string) => R {
  const cache = new WeakMap<M, Map<string, R>>();
  return (map, key) => {
    let perKey = cache.get(map);
    if (perKey === undefined) {
      perKey = new Map();
      cache.set(map, perKey);
    }
    if (perKey.has(key)) return perKey.get(key) as R;
    const value = compute(map, key);
    perKey.set(key, value);
    return value;
  };
}

type TurnMap = ReadModel["turns"];

const threadTurnsOf = memoByRef((turns: TurnMap, threadId: string): Turn[] =>
  Object.values(turns)
    .filter((t) => t.threadId === threadId)
    .sort((a, b) => a.requestedAt - b.requestedAt || a.id.localeCompare(b.id)),
);
const queuedTurnsOf = memoByRef((turns: TurnMap, threadId: string): Turn[] =>
  threadTurnsOf(turns, threadId).filter((t) => t.status === "queued"),
);
const checkpointTurnsOf = memoByRef((turns: TurnMap, threadId: string): Turn[] =>
  threadTurnsOf(turns, threadId).filter((t) => t.checkpoint !== undefined),
);
const latestSettledOf = memoByRef((turns: TurnMap, threadId: string): string | undefined => {
  const list = threadTurnsOf(turns, threadId);
  for (let i = list.length - 1; i >= 0; i--) {
    const turn = list[i] as Turn;
    if (turn.status === "completed" || turn.status === "interrupted" || turn.status === "error") return turn.id;
  }
  return undefined;
});

/** Turns of a thread in request order (oldest first); the same array while `model.turns` is unchanged. */
export function selectThreadTurns(model: ReadModel, threadId: string): Turn[] {
  return threadTurnsOf(model.turns, threadId);
}

/** Turns waiting behind the live one, oldest first — the composer's queue. */
export function selectQueuedTurns(model: ReadModel, threadId: string): Turn[] {
  return queuedTurnsOf(model.turns, threadId);
}

/** Turns that recorded a checkpoint — the ones a diff can be shown for. */
export function selectCheckpointTurns(model: ReadModel, threadId: string): Turn[] {
  return checkpointTurnsOf(model.turns, threadId);
}

/** The newest settled turn (completed, interrupted or error): the one Fork starts from. */
export function selectLatestSettledTurnId(model: ReadModel, threadId: string): string | undefined {
  return latestSettledOf(model.turns, threadId);
}

/** The prompt that opened a turn; used to label it in the turn selector. Reads only the thread's messages. */
export function selectTurnPrompt(model: ReadModel, threadId: string, turnId: string): string | undefined {
  for (const id of model.threadMessages[threadId] ?? []) {
    const message = model.messages[id];
    if (message && message.turnId === turnId && message.role === "user") return message.text;
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

const delegatesOf = memoByRef((threads: ReadModel["threads"], threadId: string): Thread[] =>
  Object.values(threads)
    .filter((t) => t.delegatedBy === threadId && t.archivedAt === undefined)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
);

/** Threads this thread spawned via `tide_delegate`, oldest first; the same array while `model.threads` is unchanged. */
export function selectDelegates(model: ReadModel, threadId: string): Thread[] {
  return delegatesOf(model.threads, threadId);
}

/** Every thread that descends from `threadId` (forks via parentThreadId, delegates via delegatedBy), archived included, any order. */
export function descendantThreads(model: ReadModel, threadId: string): Thread[] {
  const seen = new Set<string>([threadId]);
  const out: Thread[] = [];
  const queue = [threadId];
  const all = Object.values(model.threads);
  while (queue.length > 0) {
    const id = queue.pop() as string;
    for (const t of all) {
      if (seen.has(t.id) || (t.parentThreadId !== id && t.delegatedBy !== id)) continue;
      seen.add(t.id);
      out.push(t);
      queue.push(t.id);
    }
  }
  return out;
}

// ---- glass-box totals: see glassBoxSelectors.ts (re-exported below) ----

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
export function selectRunningThreads(
  model: ReadModel,
  projectId?: string,
  now: number = Date.now(),
): RunningThread[] {
  const out: RunningThread[] = [];
  for (const thread of Object.values(model.threads)) {
    if (thread.archivedAt !== undefined || isSnoozed(thread, now)) continue;
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
  /** threads whose branch landed on its base — a merged PR or a local merge-back */
  landed: number;
}

/** True once the thread's work is on its base branch, by PR or by `thread.merge`. */
export function isThreadMerged(thread: Thread): boolean {
  return thread.mergedAt !== undefined || thread.merge?.status === "merged" || thread.pr?.state === "merged";
}

export function selectPrCounts(model: ReadModel, projectId: string): PrCounts {
  const counts: PrCounts = { open: 0, merged: 0, closed: 0, landed: 0 };
  for (const thread of Object.values(model.threads)) {
    if (thread.projectId !== projectId || thread.archivedAt !== undefined) continue;
    if (thread.pr) counts[thread.pr.state] += 1;
    if (isThreadMerged(thread)) counts.landed += 1;
  }
  return counts;
}

/**
 * Every top-level-or-not thread of a project for the "All threads" list, most
 * recently active first. `archived` flips it to the archived ones (newest
 * archive first); nothing else filters — expert and delegate threads are work too.
 */
export function selectAllThreads(
  model: ReadModel,
  projectId: string,
  options: { archived?: boolean } = {},
): Thread[] {
  const archived = options.archived === true;
  return Object.values(model.threads)
    .filter((t) => t.projectId === projectId && (t.archivedAt !== undefined) === archived)
    .sort((a, b) =>
      archived
        ? (b.archivedAt ?? 0) - (a.archivedAt ?? 0) || a.id.localeCompare(b.id)
        : b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
    );
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

export { selectInbox, type InboxItem } from "./inboxSelectors.ts";
export {
  selectCostRollup,
  selectProjectTotals,
  selectProviderRateLimits,
  worstRateLimit,
  type CostRollup,
  type ProjectTotals,
  type ProviderCost,
} from "./glassBoxSelectors.ts";

/** Live (non-archived) scheduled tasks, optionally of one project; soonest next run first, unscheduled last. */
export function selectScheduledTasks(model: ReadModel, projectId?: string): ScheduledTask[] {
  return Object.values(model.scheduledTasks)
    .filter((t) => t.archivedAt === undefined && (projectId === undefined || t.projectId === projectId))
    .sort((a, b) => (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER) || a.createdAt - b.createdAt);
}

/** One chip of a team run's pipeline. */
export type TeamStageStatus = "pending" | "running" | "needs-you" | "done" | "error";
export interface TeamStageView {
  stage: TeamStage;
  /** stage 1 is the lead itself; later stages are the latest matching delegate */
  thread?: Thread;
  status: TeamStageStatus;
}

function stageStatus(thread: Thread | undefined): TeamStageStatus {
  if (thread === undefined) return "pending";
  if (thread.attention !== undefined || thread.limited !== undefined) return "needs-you";
  if (thread.status === "running") return "running";
  if (thread.status === "error" || thread.status === "interrupted") return "error";
  return "done";
}

/** The pipeline of a team lead: its stages in order, each with the delegate that runs it. */
export function selectTeamStages(model: ReadModel, leadId: string): TeamStageView[] {
  const lead = model.threads[leadId];
  if (lead?.team === undefined) return [];
  const delegates = selectDelegates(model, leadId);
  return lead.team.stages.map((stage, index) => {
    const thread =
      index === 0
        ? lead
        : delegates.filter((d) => d.delegateRole === stage.role).at(-1);
    return { stage, ...(thread === undefined ? {} : { thread }), status: stageStatus(thread) };
  });
}

/**
 * Milliseconds since anything happened on a thread (messages, activities, its latest turn's
 * request/start/settle), ignoring triage, which bumps `updatedAt`. Mirrors the server's
 * `lastActivityAt` (decisions/triage.ts).
 */
export function selectIdleMs(model: ReadModel, thread: Thread, now: number = Date.now()): number {
  let last = thread.createdAt;
  for (const id of model.threadMessages[thread.id] ?? []) last = Math.max(last, model.messages[id]?.createdAt ?? 0);
  for (const entry of model.threadTimeline[thread.id] ?? []) if (entry.kind === "activity") last = Math.max(last, model.activities[entry.id]?.updatedAt ?? 0);
  const turn = thread.latestTurnId !== undefined ? model.turns[thread.latestTurnId] : undefined;
  if (turn) last = Math.max(last, turn.requestedAt, turn.startedAt ?? 0, turn.settledAt ?? 0);
  return Math.max(0, now - last);
}
