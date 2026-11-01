import type { Activity, AttentionKind, Message, ReadModel, Thread, TimelineEntry, Turn } from "@tide/contracts";
import { clipTarget as clip, countBackgroundAgents, displayToolName, shortTarget } from "@tide/client";
import { COMPACTING_LABEL, compactionOf, isCompactPrompt } from "./compaction.ts";
import { backgroundAgentsText } from "./vocab.ts";

export { displayToolName, shortTarget };

/**
 * What a rail row says a thread is doing right now, on its second line:
 * "Bash npm test", "Writing", "Thinking", "Compacting conversation…", "Needs approval",
 * "Waiting for limit reset", "Queued", "1 agent in background".
 * Pure over the read model; undefined for an idle or settled thread.
 */
export type LiveLabelKind = "thinking" | "tool" | "waiting" | "approval" | "queued" | "limited" | "background";
export interface LiveLabelInfo {
  text: string;
  kind: LiveLabelKind | undefined;
}

const ATTENTION_TEXT: Record<AttentionKind, string> = {
  approval: "Needs approval",
  question: "Needs an answer",
  plan: "Plan ready",
};

function runningLabel(activity: Activity): string | undefined {
  if (activity.kind === "tool" && activity.status === "running") {
    const target = shortTarget(activity.input);
    const name = displayToolName(activity.toolName);
    return target === undefined ? name : `${name} ${target}`;
  }
  if (activity.kind === "child" && activity.status === "running") {
    const what = activity.description ?? activity.name;
    return `Agent ${clip(what)}`;
  }
  return undefined;
}

function activeTurn(model: ReadModel, thread: Thread): Turn | undefined {
  const turn = thread.latestTurnId === undefined ? undefined : model.turns[thread.latestTurnId];
  return turn !== undefined && (turn.status === "requested" || turn.status === "running") ? turn : undefined;
}

/** How far back a running turn's label looks: what the agent does now is at the tail. */
export const LIVE_WALK_MAX = 20;

interface TurnLabelMemo {
  turnId: string;
  /** the activities / messages the walk read, in order: same objects → same label */
  read: unknown[];
  info: LiveLabelInfo;
}

/** Keyed by the thread's timeline array, so a new entry (a new array) always misses. */
const turnLabelMemo = new WeakMap<readonly unknown[], TurnLabelMemo>();

function sameRead(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The entries of the turn in flight the label reads: the timeline's tail, newest
 * first, at most `LIVE_WALK_MAX`, stopping at the first entry of another turn.
 */
function tailOfTurn(model: ReadModel, entries: readonly TimelineEntry[], turnId: string): (Activity | Message)[] {
  const out: (Activity | Message)[] = [];
  const stop = Math.max(0, entries.length - LIVE_WALK_MAX);
  for (let i = entries.length - 1; i >= stop; i--) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const item = entry.kind === "activity" ? model.activities[entry.id] : entry.kind === "message" ? model.messages[entry.id] : undefined;
    if (item === undefined) continue;
    if (item.turnId !== turnId) break;
    out.push(item);
  }
  return out;
}

/** Tool / Writing / Thinking for the turn in flight, read backwards from the tail of the thread's timeline. */
function turnLabel(model: ReadModel, thread: Thread, turn: Turn): LiveLabelInfo {
  const entries = model.threadTimeline[thread.id] ?? [];
  const read = tailOfTurn(model, entries, turn.id);
  const memo = turnLabelMemo.get(entries);
  if (memo !== undefined && memo.turnId === turn.id && sameRead(memo.read, read)) return memo.info;
  const info = labelFromTail(read);
  turnLabelMemo.set(entries, { turnId: turn.id, read, info });
  return info;
}

function labelFromTail(read: readonly (Activity | Message)[]): LiveLabelInfo {
  let latest: "writing" | "other" | undefined;
  let harnessWake = false;
  /** the newest compaction row of the turn, if any: still running, or done */
  let compaction: "running" | "done" | undefined;
  let compactPrompt = false;
  for (const item of read) {
    if ("role" in item) {
      if (item.role === "user" && item.notification?.source === "harness") harnessWake = true;
      if (item.role === "user" && isCompactPrompt(item.text)) compactPrompt = true;
      latest ??= item.role === "assistant" && item.streaming === true && item.text !== "" ? "writing" : "other";
    } else {
      const label = runningLabel(item);
      if (label !== undefined) return { text: label, kind: "tool" };
      compaction ??= compactionOf(item)?.phase;
      latest ??= "other";
    }
  }
  if (latest === "writing") return { text: "Writing", kind: undefined };
  // `/compact` writes nothing until it is done; a harness that says it is compacting (Claude, Pi) is too
  if (compaction === "running" || (compactPrompt && compaction === undefined)) return { text: COMPACTING_LABEL, kind: "thinking" };
  if (harnessWake) return { text: "continuing after a sub-agent reported", kind: "thinking" };
  return { text: "Thinking", kind: "thinking" };
}

/** Threads with a queued turn, built once per `turns` map (a streaming delta does not replace it). */
const queuedMemo = new WeakMap<ReadModel["turns"], ReadonlySet<string>>();

function hasQueuedTurn(model: ReadModel, threadId: string): boolean {
  let queued = queuedMemo.get(model.turns);
  if (queued === undefined) {
    const ids = new Set<string>();
    for (const turn of Object.values(model.turns)) if (turn.status === "queued") ids.add(turn.threadId);
    queued = ids;
    queuedMemo.set(model.turns, queued);
  }
  return queued.has(threadId);
}

export function liveLabelFor(model: ReadModel, thread: Thread): LiveLabelInfo | undefined {
  if (thread.archivedAt !== undefined) return undefined;
  if (thread.attention !== undefined) return { text: ATTENTION_TEXT[thread.attention], kind: "approval" };
  if (thread.limited !== undefined) return { text: "Waiting for limit reset", kind: "limited" };
  if (thread.interrupting === true) return { text: "Stopping", kind: "waiting" };
  const turn = activeTurn(model, thread);
  if (turn !== undefined) return turnLabel(model, thread, turn);
  // queued turns sit behind a live one; seen here only when the thread is between turns
  if (thread.status !== "idle" && hasQueuedTurn(model, thread.id)) return { text: "Queued", kind: "queued" };
  // the turn settled, but sub-agents it launched still work: not idle, not stale
  const background = countBackgroundAgents(model, thread.id);
  if (background > 0) return { text: backgroundAgentsText(background), kind: "background" };
  return undefined;
}

/** A string the rail can select from a store without a fresh object each render. */
export function liveLabelKey(info: LiveLabelInfo | undefined): string {
  return info === undefined ? "" : `${info.kind ?? "writing"}\n${info.text}`;
}

export function parseLiveLabelKey(key: string): LiveLabelInfo | undefined {
  if (key === "") return undefined;
  const cut = key.indexOf("\n");
  const kind = key.slice(0, cut);
  return { text: key.slice(cut + 1), kind: kind === "writing" ? undefined : (kind as LiveLabelKind) };
}
