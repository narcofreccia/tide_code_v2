import type { Activity, ReadModel, Thread, Triage } from "@tide/contracts";
import type { Ask, JudgeVerdict, PerItemQuestion } from "./judge.ts";

export const SETTLED_WINDOW_MS = 30 * 60_000;
export const MAX_USER_CHARS = 800;
export const MAX_ASSISTANT_CHARS = 1200;
export const MAX_ACTIVITIES = 8;

const URGENCY_LEVELS = [
  "Can wait days: nothing is blocked and nothing needs a look soon",
  "Can wait until the user's next session",
  "Worth a look within a few hours",
  "Should be looked at soon: work is blocked or about to be",
  "Needs the user right now: blocked, failing or at risk of wasting work",
];

const NEEDS_USER = "This thread is waiting on the user: an approval, a question, a plan to accept, or it cannot proceed without them";
const STUCK = "The agent appears stuck: looping on the same tool/error, no progress for a long time, or repeating itself";
const URGENCY = "How urgently does this thread need the user's attention?";

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** Latest time anything happened on a thread, ignoring triage itself (which bumps `updatedAt`). */
export function lastActivityAt(model: ReadModel, thread: Thread): number {
  let last = thread.createdAt;
  for (const id of model.threadMessages[thread.id] ?? []) last = Math.max(last, model.messages[id]?.createdAt ?? 0);
  for (const entry of model.threadTimeline[thread.id] ?? []) if (entry.kind === "activity") last = Math.max(last, model.activities[entry.id]?.updatedAt ?? 0);
  const turn = thread.latestTurnId !== undefined ? model.turns[thread.latestTurnId] : undefined;
  if (turn) last = Math.max(last, turn.requestedAt, turn.startedAt ?? 0, turn.settledAt ?? 0);
  return last;
}

/** Threads worth sorting: running, needing the user, or settled in the last 30 minutes. */
export function triageCandidates(model: ReadModel, projectId: string, now: number): Thread[] {
  return Object.values(model.threads)
    .filter((t) => {
      if (t.projectId !== projectId || t.archivedAt !== undefined) return false;
      if (t.status === "running" || t.attention !== undefined) return true;
      const settledAt = t.latestTurnId !== undefined ? model.turns[t.latestTurnId]?.settledAt : undefined;
      return settledAt !== undefined && now - settledAt <= SETTLED_WINDOW_MS;
    })
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

function activityLine(a: Activity): string {
  switch (a.kind) {
    case "tool":
      return `${a.toolName} ${a.status}`;
    case "approval":
      return a.status === "pending" ? `PENDING APPROVAL: ${a.title ?? a.toolName} (${a.toolName})` : `approval ${a.toolName} ${a.decision ?? "resolved"}`;
    case "user-input":
      return a.status === "pending" ? `PENDING QUESTION: ${clip(a.questions.map((q) => q.text).join(" / "), 200)}` : "question answered";
    case "child":
      return `sub-agent ${a.name} ${a.status}`;
    case "error":
      return `error: ${clip(a.text, 120)}`;
    case "info":
      return `info: ${clip(a.text, 120)}`;
  }
}

function lastMessage(model: ReadModel, threadId: string, role: "user" | "assistant"): string {
  const ids = model.threadMessages[threadId] ?? [];
  for (let i = ids.length - 1; i >= 0; i--) {
    const m = model.messages[ids[i] as string];
    if (m?.role === role && m.text.length > 0) return m.text;
  }
  return "";
}

/** One thread as the model sees it. Pure. */
export function threadState(model: ReadModel, thread: Thread, now: number): Record<string, unknown> {
  const activities: string[] = [];
  const timeline = model.threadTimeline[thread.id] ?? [];
  for (let i = timeline.length - 1; i >= 0 && activities.length < MAX_ACTIVITIES; i--) {
    const entry = timeline[i];
    const a = entry?.kind === "activity" ? model.activities[entry.id] : undefined;
    if (a) activities.unshift(activityLine(a));
  }
  const planProposed = Object.values(model.plans).some((p) => p.threadId === thread.id && p.status === "proposed");
  return {
    title: thread.title,
    provider: thread.provider,
    status: thread.status,
    attention: thread.attention ?? "none",
    lastUserMessage: clip(lastMessage(model, thread.id, "user"), MAX_USER_CHARS),
    lastAssistantText: clip(lastMessage(model, thread.id, "assistant"), MAX_ASSISTANT_CHARS),
    recentActivities: activities,
    minutesSinceLastActivity: Math.max(0, Math.round((now - lastActivityAt(model, thread)) / 60_000)),
    planProposed,
  };
}

/** The triage question for one project: three sub-questions per candidate thread, one judge call per pack. */
export interface TriageQuestion {
  question: PerItemQuestion;
  /** item key -> thread id */
  threads: Map<string, string>;
}

/**
 * Only `stuck` may go to the fallback (gray zone); needs-user and urgency are Jev-only
 * (threshold 0), they are sort keys and a harness call is not worth it.
 */
export const TRIAGE_QUESTIONS: Record<"needsUser" | "stuck" | "urgency", Ask> = {
  needsUser: { kind: "yes-no", instructions: NEEDS_USER, threshold: 0 },
  stuck: { kind: "yes-no", instructions: STUCK },
  urgency: { kind: "score", instructions: URGENCY, levels: URGENCY_LEVELS, threshold: 0 },
};

export function buildTriageQuestion(model: ReadModel, projectId: string, now: number): TriageQuestion | undefined {
  const candidates = triageCandidates(model, projectId, now);
  if (candidates.length === 0) return undefined;
  const threads = new Map<string, string>();
  const items = candidates.map((thread, i) => {
    const key = `t${i}`;
    threads.set(key, thread.id);
    return { key, state: threadState(model, thread, now) };
  });
  return { question: { kind: "per-item", id: `triage:${projectId}`, site: "stuck", items, questions: TRIAGE_QUESTIONS }, threads };
}

const unit = (n: number): number => Math.max(0, Math.min(1, n));

/** Verdicts -> triage per thread id; a thread missing any answer (source none) is skipped. */
export function mapAnswers(triage: TriageQuestion, verdicts: readonly JudgeVerdict[], at: number): Map<string, Triage> {
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  const out = new Map<string, Triage>();
  const score = (key: string, name: string): number | undefined => {
    const v = byId.get(`${triage.question.id}:${key}:${name}`);
    return v !== undefined && v.source !== "none" && v.score !== undefined ? v.score : undefined;
  };
  for (const [key, threadId] of triage.threads) {
    const needsUser = score(key, "needsUser");
    const stuck = score(key, "stuck");
    const urgency = score(key, "urgency");
    if (needsUser === undefined || stuck === undefined || urgency === undefined) continue;
    out.set(threadId, { needsUser: unit(needsUser), stuck: unit(stuck), urgency: unit(urgency), at });
  }
  return out;
}
