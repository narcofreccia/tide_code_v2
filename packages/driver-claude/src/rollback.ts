import type { TranscriptEntry } from "./sdk-shapes.ts";

/**
 * Where a truncating resume must restart to forget the last `n` turns.
 * - `at`: resume with `resumeSessionAt: uuid` (the kept turn's last chain entry).
 * - `empty`: every turn is dropped; the next query starts a brand-new session.
 */
export type RollbackPoint = { kind: "at"; uuid: string } | { kind: "empty" };

export interface TurnLedger {
  /** uuids Tide supplied on each `send()` prompt, oldest first (the CLI keeps client uuids in the transcript) */
  prompts: readonly string[];
  /** uuids of steered messages: user entries inside a turn, never turn starts */
  steers: ReadonlySet<string>;
}

/** A user entry the human typed (not a tool_result carrier, not a subagent's). */
function looksLikePrompt(entry: TranscriptEntry): boolean {
  if (entry.type !== "user" || entry.parent_tool_use_id !== null) return false;
  const message = entry.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  return content.some((block) => typeof block === "object" && block !== null && (block as { type?: unknown }).type !== "tool_result");
}

/**
 * Finds the turn starts in a transcript chain. Prompts this session sent are known exactly by
 * uuid. History older than this session's first send (a resumed or forked session) has no
 * ledger, so there a turn start is any human-looking user entry: a message steered into one
 * of those older turns, or a compaction summary, counts as an extra turn there.
 */
export function turnStarts(entries: readonly TranscriptEntry[], ledger: TurnLedger): number[] {
  const known = new Set(ledger.prompts);
  const firstKnown = entries.findIndex((entry) => known.has(entry.uuid));
  const starts: number[] = [];
  entries.forEach((entry, index) => {
    if (known.has(entry.uuid)) starts.push(index);
    else if ((firstKnown === -1 || index < firstKnown) && !ledger.steers.has(entry.uuid) && looksLikePrompt(entry)) starts.push(index);
  });
  return starts;
}

/** Throws when the transcript holds fewer than `n` turns. */
export function rollbackPoint(entries: readonly TranscriptEntry[], ledger: TurnLedger, n: number): RollbackPoint {
  const starts = turnStarts(entries, ledger);
  if (n > starts.length) throw new Error(`invalid-params: cannot roll back ${n} turn(s); the claude transcript holds ${starts.length}`);
  const cut = starts[starts.length - n]!;
  const kept = entries[cut - 1];
  return kept ? { kind: "at", uuid: kept.uuid } : { kind: "empty" };
}
