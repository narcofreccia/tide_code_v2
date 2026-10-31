import type { Activity, AttentionKind, ReadModel, Thread, Turn } from "@tide/contracts";

/**
 * What a rail row says a thread is doing right now, on its second line:
 * "Bash npm test", "Writing", "Thinking", "Needs approval", "Waiting for limit reset", "Queued".
 * Pure over the read model; undefined for an idle or settled thread.
 */
export type LiveLabelKind = "thinking" | "tool" | "waiting" | "approval" | "queued" | "limited";
export interface LiveLabelInfo {
  text: string;
  kind: LiveLabelKind | undefined;
}

const ATTENTION_TEXT: Record<AttentionKind, string> = {
  approval: "Needs approval",
  question: "Needs an answer",
  plan: "Plan ready",
};

const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "file"];
const COMMAND_KEYS = ["command", "cmd", "script"];
const TEXT_KEYS = ["pattern", "query", "url", "description", "prompt", "text"];
const TARGET_MAX = 40;

function firstString(input: unknown, keys: readonly string[]): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/** One line, no quotes, at most 40 characters. */
function clip(text: string): string {
  const line = (text.split("\n")[0] ?? "").replace(/["'`]/g, "").replace(/\s+/g, " ").trim();
  return line.length > TARGET_MAX ? line.slice(0, TARGET_MAX).trimEnd() : line;
}

/** `mcp__tide__tide_delegate` → `Tide_delegate`, `mcp:github.search` → `Search`, `bash` → `Bash`. */
export function displayToolName(toolName: string): string {
  const parts = toolName.split(/__|[:.]/).filter((p) => p !== "");
  const last = parts[parts.length - 1] ?? toolName;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

/** The short target of a tool call: a path's basename, a command's first 40 characters, else a query. */
export function shortTarget(input: unknown): string | undefined {
  const path = firstString(input, PATH_KEYS);
  if (path !== undefined) {
    const base = path.split(/[\\/]/).filter((p) => p !== "").pop();
    return base === undefined ? undefined : clip(base);
  }
  const command = firstString(input, COMMAND_KEYS) ?? firstString(input, TEXT_KEYS);
  if (command === undefined) return undefined;
  const short = clip(command);
  return short === "" ? undefined : short;
}

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

/** Tool / Writing / Thinking for the turn in flight, read backwards from the thread's timeline. */
function turnLabel(model: ReadModel, thread: Thread, turn: Turn): LiveLabelInfo {
  const entries = model.threadTimeline[thread.id] ?? [];
  let latest: "writing" | "other" | undefined;
  let harnessWake = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry === undefined) continue;
    if (entry.kind === "activity") {
      const activity = model.activities[entry.id];
      if (activity === undefined) continue;
      if (activity.turnId !== turn.id) break;
      const label = runningLabel(activity);
      if (label !== undefined) return { text: label, kind: "tool" };
      latest ??= "other";
    } else if (entry.kind === "message") {
      const message = model.messages[entry.id];
      if (message === undefined) continue;
      if (message.turnId !== turn.id) break;
      if (message.role === "user" && message.notification?.source === "harness") harnessWake = true;
      latest ??= message.role === "assistant" && message.streaming === true && message.text !== "" ? "writing" : "other";
    }
  }
  if (latest === "writing") return { text: "Writing", kind: undefined };
  if (harnessWake) return { text: "continuing after a sub-agent reported", kind: "thinking" };
  return { text: "Thinking", kind: "thinking" };
}

function hasQueuedTurn(model: ReadModel, threadId: string): boolean {
  for (const turn of Object.values(model.turns)) if (turn.threadId === threadId && turn.status === "queued") return true;
  return false;
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
