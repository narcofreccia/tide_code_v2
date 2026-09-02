import type { Activity, AttentionKind, ExpertsSession, ReadModel, Thread, TimelineEntry } from "./domain.ts";
import type { DomainEvent, EventRecord } from "./events.ts";

// Pure projector shared by server and clients. Returns a new model; never
// mutates input. Unknown event types are ignored so old clients survive.

function withThread(model: ReadModel, id: string, patch: Partial<Thread>): ReadModel {
  const t = model.threads[id];
  if (!t) return model;
  return { ...model, threads: { ...model.threads, [id]: { ...t, ...patch } } };
}

function withExperts(model: ReadModel, session: ExpertsSession): ReadModel {
  return { ...model, expertsSessions: { ...model.expertsSessions, [session.id]: session } };
}

function appendTimeline(model: ReadModel, threadId: string, entry: TimelineEntry): ReadModel {
  const list = model.threadTimeline[threadId] ?? [];
  return { ...model, threadTimeline: { ...model.threadTimeline, [threadId]: [...list, entry] } };
}

/** Attention = first pending approval/question, else a proposed plan, else none. */
function deriveAttention(model: ReadModel, threadId: string): AttentionKind | undefined {
  for (const e of model.threadTimeline[threadId] ?? []) {
    if (e.kind !== "activity") continue;
    const a = model.activities[e.id];
    if (a?.kind === "approval" && a.status === "pending") return "approval";
    if (a?.kind === "user-input" && a.status === "pending") return "question";
  }
  for (const e of model.threadTimeline[threadId] ?? []) {
    if (e.kind === "plan" && model.plans[e.id]?.status === "proposed") return "plan";
  }
  return undefined;
}

function refreshAttention(model: ReadModel, threadId: string, at: number): ReadModel {
  const t = model.threads[threadId];
  if (!t) return model;
  const attention = deriveAttention(model, threadId);
  if (attention === t.attention) return model;
  const next: Thread = { ...t, updatedAt: at };
  if (attention) next.attention = attention;
  else delete next.attention;
  return { ...model, threads: { ...model.threads, [threadId]: next } };
}

function upsertActivity(model: ReadModel, activity: Activity): ReadModel {
  const exists = activity.id in model.activities;
  let next: ReadModel = { ...model, activities: { ...model.activities, [activity.id]: activity } };
  if (!exists) next = appendTimeline(next, activity.threadId, { kind: "activity", id: activity.id });
  return refreshAttention(next, activity.threadId, activity.updatedAt);
}

export function applyEvent(model: ReadModel, event: DomainEvent): ReadModel {
  switch (event.type) {
    case "project.created":
      return { ...model, projects: { ...model.projects, [event.project.id]: event.project } };
    case "project.updated": {
      const p = model.projects[event.projectId];
      if (!p) return model;
      return { ...model, projects: { ...model.projects, [p.id]: { ...p, ...(event.title !== undefined ? { title: event.title } : {}), updatedAt: event.updatedAt } } };
    }
    case "project.link.added":
    case "project.link.updated": {
      const p = model.projects[event.projectId];
      if (!p) return model;
      const links = (p.links ?? []).filter((l) => l.id !== event.link.id).concat(event.link);
      return { ...model, projects: { ...model.projects, [p.id]: { ...p, links, updatedAt: event.updatedAt } } };
    }
    case "project.link.removed": {
      const p = model.projects[event.projectId];
      if (!p) return model;
      return { ...model, projects: { ...model.projects, [p.id]: { ...p, links: (p.links ?? []).filter((l) => l.id !== event.linkId), updatedAt: event.updatedAt } } };
    }
    case "project.archived": {
      const p = model.projects[event.projectId];
      if (!p) return model;
      return { ...model, projects: { ...model.projects, [p.id]: { ...p, archivedAt: event.archivedAt, updatedAt: event.archivedAt } } };
    }
    case "thread.created":
      return {
        ...model,
        threads: { ...model.threads, [event.thread.id]: event.thread },
        threadMessages: { ...model.threadMessages, [event.thread.id]: [] },
        threadTimeline: { ...model.threadTimeline, [event.thread.id]: [] },
      };
    case "thread.updated":
      return withThread(model, event.threadId, { ...event.patch, updatedAt: event.updatedAt });
    case "thread.archived":
      return withThread(model, event.threadId, { archivedAt: event.archivedAt, updatedAt: event.archivedAt });
    case "thread.status-changed":
      return withThread(model, event.threadId, { status: event.status, updatedAt: event.updatedAt });
    case "turn.requested": {
      const { turn, userMessage } = event;
      const list = model.threadMessages[turn.threadId] ?? [];
      let next: ReadModel = {
        ...model,
        turns: { ...model.turns, [turn.id]: turn },
        messages: { ...model.messages, [userMessage.id]: userMessage },
        threadMessages: { ...model.threadMessages, [turn.threadId]: [...list, userMessage.id] },
      };
      next = appendTimeline(next, turn.threadId, { kind: "message", id: userMessage.id });
      // a queued turn waits its turn: the running one keeps latestTurnId until it settles
      if (turn.status === "queued") return withThread(next, turn.threadId, { updatedAt: turn.requestedAt });
      return withThread(next, turn.threadId, { latestTurnId: turn.id, status: "running", updatedAt: turn.requestedAt });
    }
    case "turn.dequeued": {
      const turn = model.turns[event.turnId];
      if (!turn) return model;
      const turns = { ...model.turns };
      delete turns[turn.id];
      const messages = { ...model.messages };
      const dropped = new Set((model.threadMessages[event.threadId] ?? []).filter((id) => messages[id]?.turnId === turn.id));
      for (const id of dropped) delete messages[id];
      return withThread(
        {
          ...model,
          turns,
          messages,
          threadMessages: { ...model.threadMessages, [event.threadId]: (model.threadMessages[event.threadId] ?? []).filter((id) => !dropped.has(id)) },
          threadTimeline: { ...model.threadTimeline, [event.threadId]: (model.threadTimeline[event.threadId] ?? []).filter((e) => !(e.kind === "message" && dropped.has(e.id))) },
        },
        event.threadId,
        { updatedAt: event.at },
      );
    }
    case "turn.started": {
      const turn = model.turns[event.turnId];
      if (!turn) return model;
      const next: ReadModel = {
        ...model,
        turns: { ...model.turns, [turn.id]: { ...turn, status: "running", startedAt: event.startedAt, provider: event.provider, ...(event.model !== undefined ? { model: event.model } : {}) } },
      };
      return event.nativeSessionId !== undefined ? withThread(next, event.threadId, { nativeSessionId: event.nativeSessionId, updatedAt: event.startedAt }) : next;
    }
    case "turn.interrupt-requested":
      return withThread(model, event.threadId, { interrupting: true, updatedAt: event.at });
    case "revert.requested":
    case "publish.requested":
    case "worktree.detach-requested":
      return model; // reactor-facing intents; outcomes arrive as their own events
    case "worktree.detached": {
      const t = model.threads[event.threadId];
      if (!t) return model;
      const next: Thread = { ...t, updatedAt: event.at };
      delete next.worktreePath;
      return { ...model, threads: { ...model.threads, [t.id]: next } };
    }
    case "worktree.attached":
      return withThread(model, event.threadId, {
        worktreePath: event.worktreePath,
        branch: event.branch,
        ...(event.baseBranch !== undefined ? { baseBranch: event.baseBranch } : {}),
        updatedAt: event.at,
      });
    case "checkpoint.recorded": {
      const turn = model.turns[event.turnId];
      if (!turn) return model;
      const checkpoint =
        event.phase === "before"
          ? { ...(turn.checkpoint ?? {}), before: event.ref }
          : { before: turn.checkpoint?.before ?? event.ref, after: event.ref, ...(event.stats !== undefined ? { stats: event.stats } : {}) };
      return { ...model, turns: { ...model.turns, [turn.id]: { ...turn, checkpoint } } };
    }
    case "pr.updated":
      return withThread(model, event.threadId, { pr: event.pr, updatedAt: event.pr.updatedAt });
    case "experts.created":
      return { ...model, expertsSessions: { ...model.expertsSessions, [event.session.id]: event.session } };
    case "experts.threads-bound": {
      const x = model.expertsSessions[event.sessionId];
      if (!x) return model;
      const byKey = new Map(event.bindings.map((b) => [b.key, b.threadId]));
      const experts = x.experts.map((e) => (byKey.has(e.key) ? { ...e, threadId: byKey.get(e.key) as string } : e));
      return withExperts(model, { ...x, experts, lead: { ...x.lead, threadId: event.leadThreadId }, updatedAt: event.at });
    }
    case "experts.phase-changed": {
      const x = model.expertsSessions[event.sessionId];
      return x ? withExperts(model, { ...x, phase: event.phase, updatedAt: event.at }) : model;
    }
    case "experts.expert-status-changed": {
      const x = model.expertsSessions[event.sessionId];
      if (!x) return model;
      return withExperts(model, { ...x, experts: x.experts.map((e) => (e.key === event.key ? { ...e, status: event.status } : e)), updatedAt: event.at });
    }
    case "experts.finding-posted": {
      const x = model.expertsSessions[event.finding.sessionId];
      const next: ReadModel = { ...model, expertsFindings: { ...model.expertsFindings, [event.finding.id]: event.finding } };
      return x ? withExperts(next, { ...x, findingIds: [...x.findingIds, event.finding.id], updatedAt: event.finding.createdAt }) : next;
    }
    case "experts.message-posted": {
      const x = model.expertsSessions[event.message.sessionId];
      const next: ReadModel = { ...model, expertsMessages: { ...model.expertsMessages, [event.message.id]: event.message } };
      return x ? withExperts(next, { ...x, messageIds: [...x.messageIds, event.message.id], updatedAt: event.message.createdAt }) : next;
    }
    case "experts.synthesis-set": {
      const x = model.expertsSessions[event.sessionId];
      if (!x) return model;
      return withExperts(model, { ...x, phase: "ready", synthesis: { markdown: event.markdown, at: event.at, ...(event.planId !== undefined ? { planId: event.planId } : {}) }, updatedAt: event.at });
    }
    case "experts.archived": {
      const x = model.expertsSessions[event.sessionId];
      return x ? withExperts(model, { ...x, phase: "archived", updatedAt: event.at }) : model;
    }
    case "assistant.delta": {
      const existing = model.messages[event.messageId];
      const msg = existing
        ? { ...existing, text: existing.text + event.delta }
        : { id: event.messageId, threadId: event.threadId, turnId: event.turnId, role: "assistant" as const, text: event.delta, createdAt: event.at, streaming: true };
      let next: ReadModel = { ...model, messages: { ...model.messages, [msg.id]: msg } };
      if (!existing) {
        const list = model.threadMessages[event.threadId] ?? [];
        next = { ...next, threadMessages: { ...next.threadMessages, [event.threadId]: [...list, msg.id] } };
        next = appendTimeline(next, event.threadId, { kind: "message", id: msg.id });
      }
      return next;
    }
    case "assistant.reasoning-delta": {
      const existing = model.messages[event.messageId];
      const msg = existing
        ? { ...existing, reasoning: (existing.reasoning ?? "") + event.delta }
        : { id: event.messageId, threadId: event.threadId, turnId: event.turnId, role: "assistant" as const, text: "", reasoning: event.delta, createdAt: event.at, streaming: true };
      let next: ReadModel = { ...model, messages: { ...model.messages, [msg.id]: msg } };
      if (!existing) {
        const list = model.threadMessages[event.threadId] ?? [];
        next = { ...next, threadMessages: { ...next.threadMessages, [event.threadId]: [...list, msg.id] } };
        next = appendTimeline(next, event.threadId, { kind: "message", id: msg.id });
      }
      return next;
    }
    case "activity.upserted":
      return upsertActivity(model, event.activity);
    case "approval.responded": {
      const a = Object.values(model.activities).find((x) => x.kind === "approval" && x.requestId === event.requestId && x.threadId === event.threadId);
      if (!a || a.kind !== "approval") return model;
      return upsertActivity(model, { ...a, status: "resolved", decision: event.decision, updatedAt: event.at });
    }
    case "user-input.responded": {
      const a = Object.values(model.activities).find((x) => x.kind === "user-input" && x.requestId === event.requestId && x.threadId === event.threadId);
      if (!a || a.kind !== "user-input") return model;
      return upsertActivity(model, { ...a, status: "resolved", answers: event.answers, updatedAt: event.at });
    }
    case "plan.proposed": {
      let next: ReadModel = { ...model, plans: { ...model.plans, [event.plan.id]: event.plan } };
      next = appendTimeline(next, event.plan.threadId, { kind: "plan", id: event.plan.id });
      return refreshAttention(next, event.plan.threadId, event.plan.createdAt);
    }
    case "plan.updated": {
      const plan = model.plans[event.planId];
      if (!plan) return model;
      const next: ReadModel = {
        ...model,
        plans: { ...model.plans, [plan.id]: { ...plan, status: event.status, updatedAt: event.at, ...(event.implementationThreadId !== undefined ? { implementationThreadId: event.implementationThreadId } : {}) } },
      };
      return refreshAttention(next, plan.threadId, event.at);
    }
    case "plan.progressed":
      return withThread(model, event.threadId, { planProgress: { steps: event.steps, updatedAt: event.at }, updatedAt: event.at });
    case "usage.reported": {
      const turn = model.turns[event.turnId];
      let next: ReadModel = model;
      if (turn && event.usage) next = { ...next, turns: { ...next.turns, [turn.id]: { ...turn, usage: event.usage } } };
      const t = next.threads[event.threadId];
      if (!t) return next;
      const patch: Partial<Thread> = { updatedAt: event.at };
      if (event.contextUsage) patch.contextUsage = event.contextUsage;
      if (event.usage?.costUsd !== undefined) patch.totalCostUsd = (t.totalCostUsd ?? 0) + event.usage.costUsd;
      return withThread(next, event.threadId, patch);
    }
    case "turn.settled": {
      const turn = model.turns[event.turnId];
      let messages = model.messages;
      for (const id of model.threadMessages[event.threadId] ?? []) {
        const m = messages[id];
        if (m && m.turnId === event.turnId && m.streaming) messages = { ...messages, [id]: { ...m, streaming: false } };
      }
      // pending approvals/questions of a settled turn can no longer be answered
      let activities = model.activities;
      for (const e of model.threadTimeline[event.threadId] ?? []) {
        const a = e.kind === "activity" ? activities[e.id] : undefined;
        if (a && a.turnId === event.turnId && (a.kind === "approval" || a.kind === "user-input") && a.status === "pending") {
          activities = { ...activities, [a.id]: { ...a, status: "resolved", updatedAt: event.settledAt } as Activity };
        }
        if (a && a.turnId === event.turnId && a.kind === "tool" && a.status === "running") {
          activities = { ...activities, [a.id]: { ...a, status: event.status === "completed" ? "ok" : "error", updatedAt: event.settledAt } };
        }
      }
      let next: ReadModel = {
        ...model,
        messages,
        activities,
        turns: turn ? { ...model.turns, [turn.id]: { ...turn, status: event.status, settledAt: event.settledAt, ...(event.error !== undefined ? { error: event.error } : {}) } } : model.turns,
      };
      const t = next.threads[event.threadId];
      if (t) {
        const patched: Thread = { ...t, status: event.status === "completed" ? "idle" : event.status, updatedAt: event.settledAt };
        delete patched.planProgress;
        delete patched.interrupting;
        // the oldest queued turn becomes the live one; the thread never goes idle in between
        const queued = Object.values(next.turns)
          .filter((x) => x.threadId === t.id && x.status === "queued")
          .sort((a, b) => a.requestedAt - b.requestedAt)[0];
        if (queued) {
          next = { ...next, turns: { ...next.turns, [queued.id]: { ...queued, status: "requested" } } };
          patched.latestTurnId = queued.id;
          patched.status = "running";
        }
        next = { ...next, threads: { ...next.threads, [t.id]: patched } };
      }
      return refreshAttention(next, event.threadId, event.settledAt);
    }
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return model;
    }
  }
}

export function applyRecord(model: ReadModel, rec: EventRecord): ReadModel {
  if (rec.seq <= model.seq) return model; // idempotent replay
  return { ...applyEvent(model, rec.event), seq: rec.seq };
}

export function replay(model: ReadModel, records: Iterable<EventRecord>): ReadModel {
  let m = model;
  for (const r of records) m = applyRecord(m, r);
  return m;
}
