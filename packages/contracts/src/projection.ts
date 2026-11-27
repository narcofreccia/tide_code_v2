import type { Activity, AttentionKind, ExpertsSession, Handoff, Message, Project, ReadModel, Thread, TimelineEntry, Turn } from "./domain.ts";
import type { DomainEvent, EventRecord } from "./events.ts";
import { applyUsageEvent, type UsageReplayState } from "./projectionUsage.ts";

// Pure projector shared by server and clients. `applyEvent` / `applyRecord` / `replay`
// return a new model and never mutate input. `applyRecordInPlace` reuses the same logic
// with `mut = true` on top-level maps and per-thread arrays so boot replay stays O(N).
// Unknown event types are ignored so old clients survive.

export interface ReplayState extends UsageReplayState {
  /** Turn IDs currently in `status === "queued"`, so `turn.settled` stays O(1) when nothing is queued. */
  queuedTurns: Set<string>;
}

/** Tracks auxiliary indexes for O(1) in-place boot replay on a freshly parsed or empty model. */
export function createReplayState(model?: ReadModel): ReplayState {
  const queuedTurns = new Set<string>();
  if (model) {
    for (const id in model.turns) {
      if (model.turns[id]?.status === "queued") queuedTurns.add(id);
    }
  }
  return { queuedTurns };
}

function put<T>(map: Record<string, T>, key: string, value: T, mut: boolean): Record<string, T> {
  if (mut) {
    map[key] = value;
    return map;
  }
  return { ...map, [key]: value };
}

function del<T>(map: Record<string, T>, key: string, mut: boolean): Record<string, T> {
  if (mut) {
    delete map[key];
    return map;
  }
  const next = { ...map };
  delete next[key];
  return next;
}

function push<T>(list: T[] | undefined, item: T, mut: boolean): T[] {
  if (mut && list !== undefined) {
    list.push(item);
    return list;
  }
  return list ? [...list, item] : [item];
}

function patchModel(model: ReadModel, patch: Partial<ReadModel>, mut: boolean): ReadModel {
  if (mut) return Object.assign(model, patch);
  return { ...model, ...patch };
}

function withThread(model: ReadModel, id: string, patch: Partial<Thread>, mut: boolean): ReadModel {
  const t = model.threads[id];
  if (!t) return model;
  return patchModel(model, { threads: put(model.threads, id, { ...t, ...patch }, mut) }, mut);
}

function withExperts(model: ReadModel, session: ExpertsSession, mut: boolean): ReadModel {
  return patchModel(model, { expertsSessions: put(model.expertsSessions, session.id, session, mut) }, mut);
}

function appendTimeline(model: ReadModel, threadId: string, entry: TimelineEntry, mut: boolean): ReadModel {
  const existing = model.threadTimeline[threadId];
  const next = push(existing, entry, mut);
  if (mut && existing === next) return model;
  return patchModel(model, { threadTimeline: put(model.threadTimeline, threadId, next, mut) }, mut);
}

/** Attention = first pending approval/question, else a proposed plan, else none. */
function deriveAttention(model: ReadModel, threadId: string): AttentionKind | undefined {
  // a rolled-back turn's prompts and plans no longer exist for the harness, so they cannot need the user
  const live = (turnId: string): boolean => model.turns[turnId]?.rolledBack !== true;
  for (const e of model.threadTimeline[threadId] ?? []) {
    if (e.kind !== "activity") continue;
    const a = model.activities[e.id];
    if (!a || !live(a.turnId)) continue;
    if (a.kind === "approval" && a.status === "pending") return "approval";
    if (a.kind === "user-input" && a.status === "pending") return "question";
  }
  for (const e of model.threadTimeline[threadId] ?? []) {
    if (e.kind !== "plan") continue;
    const p = model.plans[e.id];
    if (p?.status === "proposed" && live(p.turnId)) return "plan";
  }
  return undefined;
}

function refreshAttention(model: ReadModel, threadId: string, at: number, mut: boolean): ReadModel {
  const t = model.threads[threadId];
  if (!t) return model;
  const attention = deriveAttention(model, threadId);
  if (attention === t.attention) return model;
  const next: Thread = { ...t, updatedAt: at };
  if (attention) {
    next.attention = attention;
    delete next.snoozedUntil; // needing the user ends a snooze early
    delete next.settledAt; // and brings a settled thread back
    delete next.settleReason;
  } else delete next.attention;
  return patchModel(model, { threads: put(model.threads, threadId, next, mut) }, mut);
}

/** Adds a user message to a thread's lists and timeline. */
function addUserMessage(model: ReadModel, message: Message, mut: boolean): ReadModel {
  const existing = model.threadMessages[message.threadId];
  const list = push(existing, message.id, mut);
  const next = patchModel(
    model,
    {
      messages: put(model.messages, message.id, message, mut),
      ...(mut && existing === list ? {} : { threadMessages: put(model.threadMessages, message.threadId, list, mut) }),
    },
    mut,
  );
  return appendTimeline(next, message.threadId, { kind: "message", id: message.id }, mut);
}

function dropMessage(model: ReadModel, threadId: string, messageId: string, mut: boolean): ReadModel {
  return patchModel(
    model,
    {
      messages: del(model.messages, messageId, mut),
      threadMessages: put(model.threadMessages, threadId, (model.threadMessages[threadId] ?? []).filter((id) => id !== messageId), mut),
      threadTimeline: put(model.threadTimeline, threadId, (model.threadTimeline[threadId] ?? []).filter((e) => !(e.kind === "message" && e.id === messageId)), mut),
    },
    mut,
  );
}

/** Everything keyed by or belonging to the thread leaves the model; other threads keep their lineage fields. */
function dropThread(model: ReadModel, threadId: string, mut: boolean, state?: ReplayState): ReadModel {
  if (!model.threads[threadId]) return model;
  if (state) {
    for (const id of state.queuedTurns) {
      if (model.turns[id]?.threadId === threadId) state.queuedTurns.delete(id);
    }
  }
  const without = <T extends { threadId?: string }>(record: Record<string, T>): Record<string, T> => {
    if (mut) {
      for (const k in record) {
        if (record[k]?.threadId === threadId) delete record[k];
      }
      return record;
    }
    return Object.fromEntries(Object.entries(record).filter(([, v]) => v.threadId !== threadId));
  };
  return patchModel(
    model,
    {
      threads: del(model.threads, threadId, mut),
      turns: without(model.turns),
      messages: without(model.messages),
      activities: without(model.activities),
      plans: without(model.plans),
      handoffs: without(model.handoffs),
      threadMessages: del(model.threadMessages, threadId, mut),
      threadTimeline: del(model.threadTimeline, threadId, mut),
    },
    mut,
  );
}

/** `turn.requested` and the steer fallback share this: a queued turn waits, a live one takes the thread. */
function requestTurn(model: ReadModel, turn: Turn, userMessage: Message, mut: boolean, state?: ReplayState): ReadModel {
  if (turn.status === "queued") state?.queuedTurns.add(turn.id);
  let next = addUserMessage(patchModel(model, { turns: put(model.turns, turn.id, turn, mut) }, mut), userMessage, mut);
  const thread = next.threads[turn.threadId];
  // the handoff this turn carries is no longer pending on the thread
  if (thread && turn.handoffId !== undefined && thread.pendingHandoffId === turn.handoffId) {
    const t: Thread = { ...thread };
    delete t.pendingHandoffId;
    next = patchModel(next, { threads: put(next.threads, t.id, t, mut) }, mut);
  }
  // a queued turn waits its turn: the running one keeps latestTurnId until it settles
  if (turn.status === "queued") return withThread(next, turn.threadId, { updatedAt: turn.requestedAt }, mut);
  // a new turn reopens a settled thread: there is something to look at again
  const started = next.threads[turn.threadId];
  if (started?.settledAt !== undefined) {
    const t: Thread = { ...started };
    delete t.settledAt;
    delete t.settleReason;
    next = patchModel(next, { threads: put(next.threads, t.id, t, mut) }, mut);
  }
  return withThread(next, turn.threadId, { latestTurnId: turn.id, status: "running", updatedAt: turn.requestedAt }, mut);
}

/** Latest *pending* activity with this requestId: ids repeat across harness processes, so a resolved one never matches. */
function findPendingByRequest<K extends "approval" | "user-input">(model: ReadModel, kind: K, threadId: string, requestId: string): Activity | undefined {
  const timeline = model.threadTimeline[threadId] ?? [];
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i];
    if (e?.kind !== "activity") continue;
    const a = model.activities[e.id];
    if (a && a.kind === kind && a.requestId === requestId && a.status === "pending") return a;
  }
  return undefined;
}

/** Is `id` already on the thread's timeline? Scans from the tail, where upserts land. */
function timelineHasActivity(model: ReadModel, threadId: string, id: string): boolean {
  const timeline = model.threadTimeline[threadId];
  if (timeline === undefined) return false;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i];
    if (e !== undefined && e.kind === "activity" && e.id === id) return true;
  }
  return false;
}

function upsertActivity(model: ReadModel, activity: Activity, mut: boolean): ReadModel {
  const prev = model.activities[activity.id];
  // A resident-scope client (R24) may not hold an activity the timeline already lists: check
  // the timeline before appending. In-place replay always holds the full map, so it skips the scan.
  const exists = prev !== undefined || (!mut && timelineHasActivity(model, activity.threadId, activity.id));
  let next = patchModel(model, { activities: put(model.activities, activity.id, activity, mut) }, mut);
  if (!exists) next = appendTimeline(next, activity.threadId, { kind: "activity", id: activity.id }, mut);
  // Non-attention activities (tool/info/child) cannot change deriveAttention unless replacing an approval/question
  if (activity.kind !== "approval" && activity.kind !== "user-input" && prev?.kind !== "approval" && prev?.kind !== "user-input") {
    return next;
  }
  return refreshAttention(next, activity.threadId, activity.updatedAt, mut);
}

function oldestQueuedTurn(turns: Record<string, Turn>, threadId: string, state?: ReplayState): Turn | undefined {
  let best: Turn | undefined;
  if (state !== undefined) {
    if (state.queuedTurns.size === 0) return undefined;
    for (const id of state.queuedTurns) {
      const x = turns[id];
      if (x !== undefined && x.threadId === threadId && x.status === "queued" && (best === undefined || x.requestedAt < best.requestedAt)) {
        best = x;
      }
    }
    return best;
  }
  for (const id in turns) {
    const x = turns[id];
    if (x !== undefined && x.threadId === threadId && x.status === "queued" && (best === undefined || x.requestedAt < best.requestedAt)) {
      best = x;
    }
  }
  return best;
}

function projectEvent(model: ReadModel, event: DomainEvent, mut: boolean, state?: ReplayState): ReadModel {
  switch (event.type) {
    case "project.created":
      return patchModel(model, { projects: put(model.projects, event.project.id, event.project, mut) }, mut);
    case "project.updated": {
      const p = model.projects[event.projectId];
      if (!p) return model;
      const next: Project = {
        ...p,
        ...(event.title !== undefined ? { title: event.title } : {}),
        ...(event.icon !== undefined ? { icon: event.icon } : {}),
        ...(event.pinned !== undefined ? { pinned: event.pinned } : {}),
        ...(event.titleInstructions !== undefined ? { titleInstructions: event.titleInstructions } : {}),
        ...(event.repo !== undefined ? { repo: event.repo } : {}),
        updatedAt: event.updatedAt,
      };
      if (event.clearIcon) delete next.icon;
      if (event.clearTitleInstructions) delete next.titleInstructions;
      if (event.clearRepo) delete next.repo;
      return patchModel(model, { projects: put(model.projects, p.id, next, mut) }, mut);
    }
    case "project.link.added":
    case "project.link.updated": {
      const p = model.projects[event.projectId];
      if (!p) return model;
      const links = (p.links ?? []).filter((l) => l.id !== event.link.id).concat(event.link);
      return patchModel(model, { projects: put(model.projects, p.id, { ...p, links, updatedAt: event.updatedAt }, mut) }, mut);
    }
    case "project.link.removed": {
      const p = model.projects[event.projectId];
      if (!p) return model;
      return patchModel(model, { projects: put(model.projects, p.id, { ...p, links: (p.links ?? []).filter((l) => l.id !== event.linkId), updatedAt: event.updatedAt }, mut) }, mut);
    }
    case "project.runStack.changed": {
      const p = model.projects[event.projectId];
      if (!p) return model;
      return patchModel(model, { projects: put(model.projects, p.id, { ...p, runStack: event.runStack, updatedAt: event.updatedAt }, mut) }, mut);
    }
    case "project.archived": {
      const p = model.projects[event.projectId];
      if (!p) return model;
      return patchModel(model, { projects: put(model.projects, p.id, { ...p, archivedAt: event.archivedAt, updatedAt: event.archivedAt }, mut) }, mut);
    }
    case "thread.created":
      return patchModel(
        model,
        {
          threads: put(model.threads, event.thread.id, event.thread, mut),
          threadMessages: put(model.threadMessages, event.thread.id, [], mut),
          threadTimeline: put(model.threadTimeline, event.thread.id, [], mut),
        },
        mut,
      );
    case "thread.updated": {
      const t = model.threads[event.threadId];
      if (!t) return model;
      const next: Thread = { ...t, ...event.patch, updatedAt: event.updatedAt };
      if (event.clearNativeSession) delete next.nativeSessionId;
      if (event.nativeSessionId !== undefined) next.nativeSessionId = event.nativeSessionId;
      if (event.clearModel) delete next.model;
      if (event.clearEffort) delete next.effort;
      const switchedProvider =
        (event.patch.provider !== undefined && event.patch.provider !== t.provider) ||
        (event.patch.providerId !== undefined && event.patch.providerId !== t.providerId);
      if (switchedProvider) {
        delete next.rateLimit;
        delete next.contextUsage;
      }
      return patchModel(model, { threads: put(model.threads, t.id, next, mut) }, mut);
    }
    case "thread.archived":
      return withThread(model, event.threadId, { archivedAt: event.archivedAt, updatedAt: event.archivedAt }, mut);
    case "thread.unarchived": {
      const t = model.threads[event.threadId];
      if (!t) return model;
      const next: Thread = { ...t, updatedAt: event.at };
      delete next.archivedAt;
      return patchModel(model, { threads: put(model.threads, t.id, next, mut) }, mut);
    }
    case "thread.deleted":
      return dropThread(model, event.threadId, mut, state);
    case "project.unarchived": {
      const p = model.projects[event.projectId];
      if (!p) return model;
      const next = { ...p, updatedAt: event.at };
      delete next.archivedAt;
      return patchModel(model, { projects: put(model.projects, p.id, next, mut) }, mut);
    }
    case "turn.requested":
      return requestTurn(model, event.turn, event.userMessage, mut, state);
    case "turn.dequeued": {
      const turn = model.turns[event.turnId];
      if (!turn) return model;
      state?.queuedTurns.delete(turn.id);
      const turns = del(model.turns, turn.id, mut);
      const dropped = new Set((model.threadMessages[event.threadId] ?? []).filter((id) => model.messages[id]?.turnId === turn.id));
      let messages = model.messages;
      if (mut) {
        for (const id of dropped) delete messages[id];
      } else {
        messages = { ...model.messages };
        for (const id of dropped) delete messages[id];
      }
      return withThread(
        patchModel(
          model,
          {
            turns,
            messages,
            threadMessages: put(model.threadMessages, event.threadId, (model.threadMessages[event.threadId] ?? []).filter((id) => !dropped.has(id)), mut),
            threadTimeline: put(model.threadTimeline, event.threadId, (model.threadTimeline[event.threadId] ?? []).filter((e) => !(e.kind === "message" && dropped.has(e.id))), mut),
          },
          mut,
        ),
        event.threadId,
        { updatedAt: event.at },
        mut,
      );
    }
    case "turn.started": {
      const turn = model.turns[event.turnId];
      if (!turn) return model;
      state?.queuedTurns.delete(turn.id);
      const next = patchModel(
        model,
        {
          turns: put(
            model.turns,
            turn.id,
            {
              ...turn,
              status: "running",
              startedAt: event.startedAt,
              provider: event.provider,
              ...(event.providerId !== undefined ? { providerId: event.providerId } : {}),
              ...(event.model !== undefined ? { model: event.model } : {}),
            },
            mut,
          ),
        },
        mut,
      );
      if (event.nativeSessionId === undefined) return next;
      const t = next.threads[event.threadId];
      const sessionKey = event.providerId ?? event.provider;
      const sessions = { ...(t?.providerSessions ?? {}), [sessionKey]: { ...(t?.providerSessions?.[sessionKey] ?? {}), nativeSessionId: event.nativeSessionId } };
      return withThread(next, event.threadId, { nativeSessionId: event.nativeSessionId, providerSessions: sessions, updatedAt: event.startedAt }, mut);
    }
    case "turn.session-identified": {
      const turn = model.turns[event.turnId];
      if (!turn) return model;
      const next = patchModel(
        model,
        { turns: put(model.turns, turn.id, { ...turn, ...(event.model !== undefined ? { model: event.model } : {}) }, mut) },
        mut,
      );
      const t = next.threads[event.threadId];
      const sessionKey = event.providerId ?? event.provider;
      const sessions = { ...(t?.providerSessions ?? {}), [sessionKey]: { ...(t?.providerSessions?.[sessionKey] ?? {}), nativeSessionId: event.nativeSessionId } };
      return withThread(next, event.threadId, { nativeSessionId: event.nativeSessionId, providerSessions: sessions, updatedAt: event.at }, mut);
    }
    case "turn.interrupt-requested":
      return withThread(model, event.threadId, { interrupting: true, updatedAt: event.at }, mut);
    case "branch.pushed":
      return withThread(model, event.threadId, { remoteBranch: event.remoteBranch, pushedSha: event.sha, updatedAt: event.at }, mut);
    case "session.boundary": {
      const t = model.threads[event.threadId];
      if (!t) return model;
      const key = event.providerId ?? t.providerId ?? t.provider;
      const sessions = { ...(t.providerSessions ?? {}) };
      delete sessions[key];
      const patched: Thread = { ...t, providerSessions: sessions, sessionBoundaryTurnId: event.turnId, updatedAt: event.at };
      delete patched.nativeSessionId;
      const turn = model.turns[event.turnId];
      const next = turn
        ? patchModel(model, { turns: put(model.turns, turn.id, { ...turn, freshSession: true }, mut), threads: put(model.threads, t.id, patched, mut) }, mut)
        : patchModel(model, { threads: put(model.threads, t.id, patched, mut) }, mut);
      return appendTimeline(next, t.id, { kind: "boundary", id: event.turnId }, mut);
    }
    case "publish.requested":
    case "worktree.detach-requested":
      return model; // reactor-facing intents; outcomes arrive as their own events
    case "worktree.detached": {
      const t = model.threads[event.threadId];
      if (!t) return model;
      const next: Thread = { ...t, updatedAt: event.at };
      delete next.worktreePath;
      return patchModel(model, { threads: put(model.threads, t.id, next, mut) }, mut);
    }
    case "worktree.attached":
      return withThread(
        model,
        event.threadId,
        {
          worktreePath: event.worktreePath,
          branch: event.branch,
          ...(event.baseBranch !== undefined ? { baseBranch: event.baseBranch } : {}),
          updatedAt: event.at,
        },
        mut,
      );
    case "checkpoint.recorded": {
      const turn = model.turns[event.turnId];
      if (!turn) return model;
      const checkpoint =
        event.phase === "before"
          ? { ...(turn.checkpoint ?? {}), before: event.ref }
          : { before: turn.checkpoint?.before ?? event.ref, after: event.ref, ...(event.stats !== undefined ? { stats: event.stats } : {}) };
      return patchModel(model, { turns: put(model.turns, turn.id, { ...turn, checkpoint }, mut) }, mut);
    }
    case "pr.updated": {
      const t = model.threads[event.threadId];
      const patch: Partial<Thread> = { pr: event.pr, updatedAt: event.pr.updatedAt };
      // R10: the forge's merge time when it reports one, else the poll time
      if (event.pr.state === "merged" && t?.mergedAt === undefined) patch.mergedAt = event.pr.mergedAt ?? event.pr.updatedAt;
      if (t?.prWatch) patch.prWatch = { ...t.prWatch, lastCheckedAt: event.pr.updatedAt };
      return withThread(model, event.threadId, patch, mut);
    }
    case "merge.requested":
      return withThread(model, event.threadId, { merge: { status: "merging", strategy: event.strategy, at: event.at }, updatedAt: event.at }, mut);
    case "merge.completed":
      return withThread(
        model,
        event.threadId,
        {
          merge: { status: "merged", strategy: event.strategy, at: event.at, ...(event.sha !== undefined ? { sha: event.sha } : {}) },
          mergedAt: event.at,
          updatedAt: event.at,
        },
        mut,
      );
    case "merge.conflicted":
      return withThread(model, event.threadId, { merge: { status: "conflicted", strategy: event.strategy, files: event.files, at: event.at }, updatedAt: event.at }, mut);
    case "merge.failed":
      return withThread(model, event.threadId, { merge: { status: "error", strategy: event.strategy, error: event.error, at: event.at }, updatedAt: event.at }, mut);
    case "thread.triaged":
      return withThread(model, event.threadId, { triage: event.triage, updatedAt: event.triage.at }, mut);
    case "experts.created":
      return patchModel(model, { expertsSessions: put(model.expertsSessions, event.session.id, event.session, mut) }, mut);
    case "experts.threads-bound": {
      const x = model.expertsSessions[event.sessionId];
      if (!x) return model;
      const byKey = new Map(event.bindings.map((b) => [b.key, b.threadId]));
      const experts = x.experts.map((e) => (byKey.has(e.key) ? { ...e, threadId: byKey.get(e.key) as string } : e));
      return withExperts(model, { ...x, experts, lead: { ...x.lead, threadId: event.leadThreadId }, updatedAt: event.at }, mut);
    }
    case "experts.phase-changed": {
      const x = model.expertsSessions[event.sessionId];
      return x ? withExperts(model, { ...x, phase: event.phase, updatedAt: event.at }, mut) : model;
    }
    case "experts.expert-status-changed": {
      const x = model.expertsSessions[event.sessionId];
      if (!x) return model;
      return withExperts(model, { ...x, experts: x.experts.map((e) => (e.key === event.key ? { ...e, status: event.status } : e)), updatedAt: event.at }, mut);
    }
    case "experts.finding-posted": {
      const x = model.expertsSessions[event.finding.sessionId];
      const next = patchModel(model, { expertsFindings: put(model.expertsFindings, event.finding.id, event.finding, mut) }, mut);
      return x ? withExperts(next, { ...x, findingIds: [...x.findingIds, event.finding.id], updatedAt: event.finding.createdAt }, mut) : next;
    }
    case "experts.message-posted": {
      const x = model.expertsSessions[event.message.sessionId];
      const next = patchModel(model, { expertsMessages: put(model.expertsMessages, event.message.id, event.message, mut) }, mut);
      return x ? withExperts(next, { ...x, messageIds: [...x.messageIds, event.message.id], updatedAt: event.message.createdAt }, mut) : next;
    }
    case "experts.synthesis-set": {
      const x = model.expertsSessions[event.sessionId];
      if (!x) return model;
      return withExperts(model, { ...x, phase: "ready", synthesis: { markdown: event.markdown, at: event.at, ...(event.planId !== undefined ? { planId: event.planId } : {}) }, updatedAt: event.at }, mut);
    }
    case "experts.archived": {
      const x = model.expertsSessions[event.sessionId];
      return x ? withExperts(model, { ...x, phase: "archived", updatedAt: event.at }, mut) : model;
    }
    case "assistant.delta": {
      const existing = model.messages[event.messageId];
      if (mut && existing) {
        existing.text += event.delta;
        return model;
      }
      const msg = existing
        ? { ...existing, text: existing.text + event.delta }
        : { id: event.messageId, threadId: event.threadId, turnId: event.turnId, role: "assistant" as const, text: event.delta, createdAt: event.at, streaming: true };
      let next = patchModel(model, { messages: put(model.messages, msg.id, msg, mut) }, mut);
      if (!existing) {
        const list = model.threadMessages[event.threadId];
        const nextList = push(list, msg.id, mut);
        if (!mut || list !== nextList) next = patchModel(next, { threadMessages: put(next.threadMessages, event.threadId, nextList, mut) }, mut);
        next = appendTimeline(next, event.threadId, { kind: "message", id: msg.id }, mut);
      }
      return next;
    }
    case "assistant.reasoning-delta": {
      const existing = model.messages[event.messageId];
      if (mut && existing) {
        existing.reasoning = (existing.reasoning ?? "") + event.delta;
        return model;
      }
      const msg = existing
        ? { ...existing, reasoning: (existing.reasoning ?? "") + event.delta }
        : { id: event.messageId, threadId: event.threadId, turnId: event.turnId, role: "assistant" as const, text: "", reasoning: event.delta, createdAt: event.at, streaming: true };
      let next = patchModel(model, { messages: put(model.messages, msg.id, msg, mut) }, mut);
      if (!existing) {
        const list = model.threadMessages[event.threadId];
        const nextList = push(list, msg.id, mut);
        if (!mut || list !== nextList) next = patchModel(next, { threadMessages: put(next.threadMessages, event.threadId, nextList, mut) }, mut);
        next = appendTimeline(next, event.threadId, { kind: "message", id: msg.id }, mut);
      }
      return next;
    }
    case "activity.upserted":
      return upsertActivity(model, event.activity, mut);
    case "approval.responded": {
      const a = event.activityId !== undefined ? model.activities[event.activityId] : findPendingByRequest(model, "approval", event.threadId, event.requestId);
      if (!a || a.kind !== "approval") return model;
      return upsertActivity(model, { ...a, status: "resolved", decision: event.decision, updatedAt: event.at }, mut);
    }
    case "user-input.responded": {
      const a = event.activityId !== undefined ? model.activities[event.activityId] : findPendingByRequest(model, "user-input", event.threadId, event.requestId);
      if (!a || a.kind !== "user-input") return model;
      return upsertActivity(model, { ...a, status: "resolved", answers: event.answers, updatedAt: event.at }, mut);
    }
    case "plan.proposed": {
      // A newer plan on the same thread supersedes any earlier unacted-on proposal so refining a
      // plan never leaves stale "Plan ready" cards behind in the inbox or stream.
      let plans = model.plans;
      for (const e of model.threadTimeline[event.plan.threadId] ?? []) {
        if (e.kind !== "plan") continue;
        const prev = plans[e.id];
        if (prev?.status === "proposed") {
          plans = put(plans, prev.id, { ...prev, status: "superseded", updatedAt: event.plan.createdAt }, mut);
        }
      }
      let next = patchModel(model, { plans: put(plans, event.plan.id, event.plan, mut) }, mut);
      next = appendTimeline(next, event.plan.threadId, { kind: "plan", id: event.plan.id }, mut);
      return refreshAttention(next, event.plan.threadId, event.plan.createdAt, mut);
    }
    case "plan.updated": {
      const plan = model.plans[event.planId];
      if (!plan) return model;
      let plans = put(
        model.plans,
        plan.id,
        { ...plan, status: event.status, updatedAt: event.at, ...(event.implementationThreadId !== undefined ? { implementationThreadId: event.implementationThreadId } : {}) },
        mut,
      );
      if (event.status === "implemented") {
        for (const e of model.threadTimeline[plan.threadId] ?? []) {
          if (e.kind !== "plan" || e.id === plan.id) continue;
          const other = plans[e.id];
          if (other?.status === "proposed") {
            plans = put(plans, other.id, { ...other, status: "superseded", updatedAt: event.at }, mut);
          }
        }
      }
      const next = patchModel(model, { plans }, mut);
      return refreshAttention(next, plan.threadId, event.at, mut);
    }
    case "plan.progressed":
      return withThread(model, event.threadId, { planProgress: { steps: event.steps, updatedAt: event.at }, updatedAt: event.at }, mut);
    case "usage.reported":
    case "usage.corrected":
    case "quota.changed":
    case "quota.lifted":
    case "quota.metered":
    case "turn.released":
      return applyUsageEvent(model, event, mut, state);
    case "turn.settled": {
      const turn = model.turns[event.turnId];
      state?.queuedTurns.delete(event.turnId);
      let messages = model.messages;
      for (const id of model.threadMessages[event.threadId] ?? []) {
        const m = messages[id];
        if (m && m.turnId === event.turnId && m.streaming) messages = put(messages, id, { ...m, streaming: false }, mut);
      }
      // pending approvals/questions of a settled turn can no longer be answered
      let activities = model.activities;
      for (const e of model.threadTimeline[event.threadId] ?? []) {
        const a = e.kind === "activity" ? activities[e.id] : undefined;
        if (a && a.turnId === event.turnId && (a.kind === "approval" || a.kind === "user-input") && a.status === "pending") {
          activities = put(activities, a.id, { ...a, status: "resolved", updatedAt: event.settledAt } as Activity, mut);
        }
        if (a && a.turnId === event.turnId && a.kind === "tool" && a.status === "running") {
          activities = put(activities, a.id, { ...a, status: event.status === "completed" ? "ok" : "error", updatedAt: event.settledAt }, mut);
        }
      }
      let next = patchModel(
        model,
        {
          messages,
          activities,
          turns: turn
            ? put(model.turns, turn.id, { ...turn, status: event.status, settledAt: event.settledAt, ...(event.error !== undefined ? { error: event.error } : {}) }, mut)
            : model.turns,
        },
        mut,
      );
      const t = next.threads[event.threadId];
      if (t) {
        const patched: Thread = { ...t, status: event.status === "completed" ? "idle" : event.status, updatedAt: event.settledAt };
        delete patched.planProgress;
        delete patched.interrupting;
        // the harness that ran this turn has now seen it: a later switch back needs only the delta after it
        const provider = turn?.providerId ?? turn?.provider;
        const known = provider === undefined ? undefined : t.providerSessions?.[provider];
        if (provider !== undefined && known !== undefined) patched.providerSessions = { ...t.providerSessions, [provider]: { ...known, lastTurnId: event.turnId } };
        // the oldest queued turn becomes the live one; the thread never goes idle in between.
        // R20: unless a quota holds the thread: then it goes idle with its queue, until a `turn.released`
        const queued = event.holdQueue === true ? undefined : oldestQueuedTurn(next.turns, t.id, state);
        if (queued) {
          state?.queuedTurns.delete(queued.id);
          next = patchModel(next, { turns: put(next.turns, queued.id, { ...queued, status: "requested" }, mut) }, mut);
          patched.latestTurnId = queued.id;
          patched.status = "running";
        }
        next = patchModel(next, { threads: put(next.threads, t.id, patched, mut) }, mut);
      }
      return refreshAttention(next, event.threadId, event.settledAt, mut);
    }
    // ---- R4 ----
    case "turn.steered":
      return withThread(addUserMessage(model, event.message, mut), event.threadId, { updatedAt: event.message.createdAt }, mut);
    case "turn.steer-fell-back":
      return requestTurn(dropMessage(model, event.threadId, event.messageId, mut), { ...event.turn, steerFallback: { reason: event.reason } }, event.userMessage, mut, state);
    case "turn.edited": {
      const m = model.messages[event.messageId];
      if (!m) return model;
      return withThread(patchModel(model, { messages: put(model.messages, m.id, { ...m, text: event.text }, mut) }, mut), event.threadId, { updatedAt: event.at }, mut);
    }
    case "turns.reordered": {
      // promotion picks the smallest requestedAt among queued turns, so the order is encoded there
      const base = Math.min(...event.turnIds.map((id) => model.turns[id]?.requestedAt ?? event.at));
      let turns = model.turns;
      event.turnIds.forEach((id, i) => {
        const turn = turns[id];
        if (turn && turn.status === "queued") turns = put(turns, id, { ...turn, requestedAt: base + i }, mut);
      });
      return withThread(patchModel(model, { turns }, mut), event.threadId, { updatedAt: event.at }, mut);
    }
    case "handoff.recorded":
      return withThread(
        patchModel(model, { handoffs: put(model.handoffs, event.handoff.id, event.handoff, mut) }, mut),
        event.handoff.threadId,
        { pendingHandoffId: event.handoff.id, updatedAt: event.handoff.createdAt },
        mut,
      );
    case "handoff.refined": {
      const h = model.handoffs[event.handoffId];
      if (!h) return model;
      const next: Handoff = { ...h, text: event.text, coveredTurnIds: event.coveredTurnIds, omittedTurnIds: event.omittedTurnIds, judge: event.judge };
      return withThread(patchModel(model, { handoffs: put(model.handoffs, h.id, next, mut) }, mut), h.threadId, { updatedAt: event.at }, mut);
    }
    case "judge.recorded": {
      const { target, verdict } = event;
      if (target.kind === "thread") return withThread(model, target.id, { judge: verdict, updatedAt: verdict.at }, mut);
      if (target.kind === "experts") {
        const s = model.expertsSessions[target.id];
        if (!s) return model;
        return patchModel(model, { expertsSessions: put(model.expertsSessions, s.id, { ...s, judge: verdict, updatedAt: verdict.at }, mut) }, mut);
      }
      const a = model.activities[target.id];
      if (!a || a.kind !== "approval") return model;
      return patchModel(model, { activities: put(model.activities, a.id, { ...a, judge: verdict }, mut) }, mut);
    }
    case "handoff.delivered": {
      const turn = model.turns[event.turnId];
      if (!turn) return model;
      return patchModel(model, { turns: put(model.turns, turn.id, { ...turn, handoffId: event.handoffId, handoffDelivery: event.delivery }, mut) }, mut);
    }
    case "rollback.requested":
      return withThread(model, event.threadId, { rollback: { status: "rolling", turnId: event.turnId, restoreFiles: event.restoreFiles, at: event.at }, updatedAt: event.at }, mut);
    case "rollback.completed": {
      const t = model.threads[event.threadId];
      if (!t) return model;
      const gone = new Set(event.turnIds);
      let turns = model.turns;
      for (const id of gone) {
        const turn = turns[id];
        if (turn) turns = put(turns, id, { ...turn, rolledBack: true }, mut);
      }
      // the newest surviving turn is the one the harness's history now ends on
      const survivor = Object.values(turns)
        .filter((x) => x.threadId === t.id && !x.rolledBack && x.status !== "queued")
        .sort((a, b) => b.requestedAt - a.requestedAt)[0];
      const patched: Thread = { ...t, rollback: { ...(t.rollback ?? { restoreFiles: false }), status: "done", turnId: event.turnId, at: event.at }, updatedAt: event.at };
      if (survivor) patched.latestTurnId = survivor.id;
      else delete patched.latestTurnId;
      delete patched.planProgress;
      // rolling back the boundary turn itself removes the boundary (the divider goes with it)
      if (patched.sessionBoundaryTurnId !== undefined && gone.has(patched.sessionBoundaryTurnId)) delete patched.sessionBoundaryTurnId;
      // the harness that did the rollback keeps its session (under its possibly new id); any other
      // harness whose last-seen turn is gone still remembers it, so a switch back must start fresh
      if (t.providerSessions) {
        const sessions: NonNullable<Thread["providerSessions"]> = {};
        for (const [provider, entry] of Object.entries(t.providerSessions)) {
          const stale = entry.lastTurnId !== undefined && gone.has(entry.lastTurnId);
          if (provider === event.provider) {
            const last = Object.values(turns).filter((x) => x.threadId === t.id && !x.rolledBack && x.provider === provider && x.startedAt !== undefined).sort((a, b) => b.requestedAt - a.requestedAt)[0];
            const next = { ...entry, ...(event.nativeSessionId !== undefined ? { nativeSessionId: event.nativeSessionId } : {}) };
            if (last) next.lastTurnId = last.id;
            else delete next.lastTurnId;
            sessions[provider] = next;
          } else if (!stale) sessions[provider] = entry;
        }
        patched.providerSessions = sessions;
      }
      if (event.nativeSessionId !== undefined) patched.nativeSessionId = event.nativeSessionId;
      // If rollback undid the turn whose plan superseded an earlier surviving plan, restore that
      // newest surviving proposal so the user can act on it again.
      let plans = model.plans;
      let lastSurvivingPlanId: string | undefined;
      let rolledBackPlanAfter = false;
      for (const e of model.threadTimeline[t.id] ?? []) {
        if (e.kind !== "plan") continue;
        const p = plans[e.id];
        if (!p) continue;
        if (turns[p.turnId]?.rolledBack === true) {
          if (lastSurvivingPlanId !== undefined) rolledBackPlanAfter = true;
        } else {
          lastSurvivingPlanId = p.id;
          rolledBackPlanAfter = false;
        }
      }
      if (rolledBackPlanAfter && lastSurvivingPlanId !== undefined) {
        const prev = plans[lastSurvivingPlanId];
        if (prev?.status === "superseded") {
          plans = put(plans, prev.id, { ...prev, status: "proposed", updatedAt: event.at }, mut);
        }
      }
      return refreshAttention(patchModel(model, { turns, plans, threads: put(model.threads, t.id, patched, mut) }, mut), t.id, event.at, mut);
    }
    case "rollback.failed": {
      const t = model.threads[event.threadId];
      if (!t) return model;
      return withThread(model, t.id, { rollback: { ...(t.rollback ?? { restoreFiles: false }), status: "error", turnId: event.turnId, error: event.error, at: event.at }, updatedAt: event.at }, mut);
    }
    case "thread.limited":
      return withThread(model, event.threadId, { limited: event.limited, updatedAt: event.limited.at }, mut);
    case "thread.limit-policy-changed": {
      const t = model.threads[event.threadId];
      if (!t?.limited) return model;
      return withThread(model, t.id, { limited: { ...t.limited, resume: event.resume }, updatedAt: event.at }, mut);
    }
    case "thread.snoozed":
      return withThread(model, event.threadId, { snoozedUntil: event.until, updatedAt: event.at }, mut);
    case "thread.settled":
      return withThread(model, event.threadId, { settledAt: event.at, settleReason: event.reason, updatedAt: event.at }, mut);
    case "thread.unsettled": {
      const t = model.threads[event.threadId];
      if (!t) return model;
      const next: Thread = { ...t, updatedAt: event.at };
      delete next.settledAt;
      delete next.settleReason;
      return patchModel(model, { threads: put(model.threads, t.id, next, mut) }, mut);
    }
    case "thread.resumed": {
      const t = model.threads[event.threadId];
      if (!t) return model;
      const next: Thread = { ...t, updatedAt: event.at };
      delete next.limited;
      delete next.snoozedUntil;
      return patchModel(model, { threads: put(model.threads, t.id, next, mut) }, mut);
    }
    case "task.created":
      return patchModel(model, { scheduledTasks: put(model.scheduledTasks, event.task.id, event.task, mut) }, mut);
    case "task.updated": {
      const task = model.scheduledTasks[event.taskId];
      if (!task) return model;
      return patchModel(model, { scheduledTasks: put(model.scheduledTasks, task.id, { ...task, ...event.patch, updatedAt: event.updatedAt }, mut) }, mut);
    }
    case "task.deleted": {
      const task = model.scheduledTasks[event.taskId];
      if (!task) return model;
      return patchModel(model, { scheduledTasks: put(model.scheduledTasks, task.id, { ...task, archivedAt: event.at, updatedAt: event.at }, mut) }, mut);
    }
    case "task.fired": {
      const task = model.scheduledTasks[event.taskId];
      if (!task) return model;
      const next = { ...task, runs: task.runs + 1, lastRunAt: event.at, lastRunThreadId: event.threadId, updatedAt: event.at };
      if (event.nextRunAt !== undefined) next.nextRunAt = event.nextRunAt;
      return patchModel(model, { scheduledTasks: put(model.scheduledTasks, task.id, next, mut) }, mut);
    }
    case "pr.watch-changed": {
      const t = model.threads[event.threadId];
      if (!t) return model;
      const next: Thread = { ...t, updatedAt: event.at };
      if (event.enabled) next.prWatch = { since: event.at };
      else delete next.prWatch;
      return patchModel(model, { threads: put(model.threads, t.id, next, mut) }, mut);
    }
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return model;
    }
  }
}

export function applyEvent(model: ReadModel, event: DomainEvent): ReadModel {
  return projectEvent(model, event, false);
}

export function applyRecord(model: ReadModel, rec: EventRecord): ReadModel {
  if (rec.seq <= model.seq) return model; // idempotent replay
  return { ...projectEvent(model, rec.event, false), seq: rec.seq };
}

/**
 * In-place variant of {@link applyRecord} for boot replay on a freshly constructed or parsed
 * `ReadModel`. Produces the exact same state as `applyRecord` while avoiding O(N²) map clones.
 */
export function applyRecordInPlace(model: ReadModel, rec: EventRecord, state?: ReplayState): ReadModel {
  if (rec.seq <= model.seq) return model;
  const next = projectEvent(model, rec.event, true, state);
  next.seq = rec.seq;
  return next;
}

export function replay(model: ReadModel, records: Iterable<EventRecord>): ReadModel {
  let m = model;
  for (const r of records) m = applyRecord(m, r);
  return m;
}
