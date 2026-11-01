import type { ClaudeMessage, TranscriptEntry } from "./sdk-shapes.ts";

/**
 * Where a truncating resume must restart to forget the last `n` turns.
 * - `at`: resume with `resumeSessionAt: uuid` (the kept turn's last chain entry).
 * - `empty`: every turn is dropped; the next query starts a brand-new session.
 */
export type RollbackPoint = { kind: "at"; uuid: string } | { kind: "empty" };

export interface TurnLedger {
  /**
   * uuids of the transcript entries that begin this session's turns, oldest first: the uuid
   * Tide supplied on each `send()` prompt (the CLI keeps client uuids in the transcript) and the
   * first entry of each harness turn the server recorded (a `<task-notification>` user entry, or
   * the assistant entry Claude Code opened the turn with).
   */
  starts: readonly string[];
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

/** Ledger slot of a harness turn whose first transcript entry is not read yet (never in a transcript). */
const PLACEHOLDER = "harness-turn:";

/** Moves an assistant-entry start back over the unknown, un-steered prompt-like user entries right before it. */
function backOver(entries: readonly TranscriptEntry[], at: number, ledger: TurnLedger, known: ReadonlySet<string>): number {
  let position = at;
  if (entries[at]!.type !== "assistant") return position;
  while (position > 0) {
    const before = entries[position - 1]!;
    if (known.has(before.uuid) || ledger.steers.has(before.uuid) || !looksLikePrompt(before)) break;
    position--;
  }
  return position;
}

/**
 * Finds the turn starts in a transcript chain (ascending indices) and where each ledger start
 * landed. Starts this session recorded are known exactly by uuid. History older than the first
 * known start (a resumed or forked session) has no ledger, so there a turn start is any
 * human-looking user entry: a `<task-notification>` that woke the model counts, as it should; a
 * message steered into one of those older turns, a notification folded into a running turn, or
 * a compaction summary counts as an extra turn there.
 *
 * A known start missing from the transcript (a send that failed before the CLI wrote its prompt,
 * a harness turn that ended before writing anything) is an empty turn just before the next known
 * start, so the server, which counts it, agrees. A known start that is an assistant entry (a
 * harness turn the CLI opened without a visible prompt) also takes the unknown, un-steered user
 * entries right before it.
 */
export function locateStarts(entries: readonly TranscriptEntry[], ledger: TurnLedger): { starts: number[]; positions: Map<string, number> } {
  const index = new Map(entries.map((entry, i) => [entry.uuid, i] as const));
  const known = new Set(ledger.starts);
  const firstFound = ledger.starts.findIndex((uuid) => index.has(uuid));
  const positions = new Map<string, number>();
  let next = entries.length;
  for (let k = ledger.starts.length - 1; k >= 0; k--) {
    const uuid = ledger.starts[k]!;
    const at = index.get(uuid);
    if (at !== undefined) {
      next = backOver(entries, at, ledger, known);
      positions.set(uuid, next);
    } else if ((firstFound >= 0 && k > firstFound) || uuid.startsWith(PLACEHOLDER)) {
      // a missing prompt older than every found one is history the CLI compacted away, not a turn
      positions.set(uuid, next);
    }
  }
  const found = [...positions.entries()].filter(([uuid]) => index.has(uuid)).map(([, position]) => position);
  const firstKnown = found.length > 0 ? Math.min(...found) : -1;
  const starts: number[] = [];
  entries.forEach((entry, i) => {
    if ((firstKnown === -1 || i < firstKnown) && !ledger.steers.has(entry.uuid) && !known.has(entry.uuid) && looksLikePrompt(entry)) starts.push(i);
  });
  starts.push(...positions.values());
  starts.sort((x, y) => x - y);
  return { starts, positions };
}

export function turnStarts(entries: readonly TranscriptEntry[], ledger: TurnLedger): number[] {
  return locateStarts(entries, ledger).starts;
}

/** Throws when the transcript holds fewer than `n` turns. */
export function rollbackPoint(entries: readonly TranscriptEntry[], ledger: TurnLedger, n: number): RollbackPoint {
  return cutAt(entries, locateStarts(entries, ledger).starts, n).point;
}

function cutAt(entries: readonly TranscriptEntry[], starts: readonly number[], n: number): { point: RollbackPoint; cut: number } {
  if (n > starts.length) throw new Error(`invalid-params: cannot roll back ${n} turn(s); the claude transcript holds ${starts.length}`);
  const cut = starts[starts.length - n]!;
  const kept = entries[cut - 1];
  return { point: kept ? { kind: "at", uuid: kept.uuid } : { kind: "empty" }, cut };
}

/** The transcript uuid a streamed message is written under, when it is a main-chain user/assistant entry. */
export function transcriptUuid(message: ClaudeMessage): string | undefined {
  if (message.type !== "user" && message.type !== "assistant") return undefined;
  const entry = message as { uuid?: unknown; parent_tool_use_id?: unknown };
  if (typeof entry.uuid !== "string" || (entry.parent_tool_use_id !== null && entry.parent_tool_use_id !== undefined)) return undefined;
  return entry.uuid;
}

/** A harness turn as the ledger sees it: its key and, once read, its first transcript entry. */
export interface LedgerTurn {
  readonly key: string;
  start: string | undefined;
}

/**
 * The session's turn starts and steers, in the server's terms: every `send()` and every harness
 * turn the server recorded is a turn; steers never are. A harness turn takes its slot when it
 * opens (so the order is the order turns ran) and fills it with its first entry once read.
 */
export class SessionLedger implements TurnLedger {
  starts: string[] = [];
  readonly steers = new Set<string>();

  prompt(uuid: string): void {
    this.starts.push(uuid);
  }

  steer(uuid: string): void {
    this.steers.add(uuid);
  }

  harnessOpened(turn: LedgerTurn): void {
    this.starts.push(PLACEHOLDER + turn.key);
  }

  /** Records the first transcript entry of a harness turn (once; never a steer or a prompt of ours). */
  harnessMessage(turn: LedgerTurn, message: ClaudeMessage): void {
    if (turn.start !== undefined) return;
    const uuid = transcriptUuid(message);
    if (uuid === undefined || this.steers.has(uuid) || this.starts.includes(uuid)) return;
    turn.start = uuid;
    this.starts = this.starts.map((start) => (start === PLACEHOLDER + turn.key ? uuid : start));
  }

  /** The server will not record the turn: its entries belong to the turn before it. */
  dismiss(turn: LedgerTurn): void {
    this.starts = this.starts.filter((start) => start !== PLACEHOLDER + turn.key && start !== turn.start);
  }

  /** Where to resume to forget the last `n` turns; the starts of the cut turns are forgotten. */
  cut(entries: readonly TranscriptEntry[], n: number): RollbackPoint {
    const { starts, positions } = locateStarts(entries, this);
    const { point, cut } = cutAt(entries, starts, n);
    this.starts = this.starts.filter((uuid) => (positions.get(uuid) ?? -1) < cut);
    return point;
  }
}
