import type { PiRpc } from "./rpc.ts";

/**
 * Which session entry started each Tide turn, so `rollback(n)` knows where to cut.
 *
 * A pi session is an append-only tree of entries with stable ids (docs/rpc-commands.md
 * § get_entries). One Tide `send()` is one `prompt`, which appends one user message entry; a
 * `steer` delivered during that run appends another user message, so "count user messages from
 * the end" is wrong. Two sources, newest wins:
 *  - this process's own sends: after each turn `get_entries {since: cursor}` returns exactly
 *    what the turn appended, and the first user message in it is the turn's prompt;
 *  - history from before this process (a resumed or `--fork`ed session): walk the active branch
 *    and treat a user message as a turn start unless pi was mid-run when it arrived (the
 *    previous message is a tool result or an assistant message that stopped for tool use),
 *    which is where pi delivers steering messages.
 * The heuristic miscounts one case: a steer that lands after the model's final, tool-free
 * answer looks like a new prompt. Turns recorded by this process are never guessed.
 */

export interface PiEntry {
  type: string;
  id: string;
  parentId?: string | null;
  message?: { role?: string; stopReason?: string };
}

interface EntriesData {
  entries?: PiEntry[];
  leafId?: string | null;
}

function isUserMessage(entry: PiEntry): boolean {
  return entry.type === "message" && entry.message?.role === "user";
}

export function firstUserEntry(entries: PiEntry[]): string | undefined {
  return entries.find(isUserMessage)?.id;
}

/** The active branch, root first: follow `parentId` back from the leaf. */
export function activeBranch(entries: PiEntry[], leafId: string | null | undefined): PiEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: PiEntry[] = [];
  const seen = new Set<string>();
  let cursor = leafId ?? undefined;
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    const entry = byId.get(cursor);
    if (!entry) break;
    branch.push(entry);
    cursor = entry.parentId ?? undefined;
  }
  return branch.reverse();
}

/** User messages on `branch` that started a run (see the module comment), oldest first. */
export function branchTurnStarts(branch: PiEntry[]): string[] {
  const starts: string[] = [];
  let midRun = false;
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const role = entry.message?.role;
    if (role === "user") {
      if (!midRun) starts.push(entry.id);
      midRun = true;
    } else if (role === "toolResult") {
      midRun = true;
    } else if (role === "assistant") {
      midRun = entry.message?.stopReason === "toolUse";
    } else {
      midRun = false;
    }
  }
  return starts;
}

export class PiTurnLedger {
  #rpc: PiRpc;
  /** the newest entry id this ledger has seen; `get_entries {since}` reads past it */
  #cursor: string | undefined;
  /** per send of this process: the user entry that started it, or undefined when nothing ran */
  #turns: (string | undefined)[] = [];
  /** `get_entries` failed once, so this process's turns can't be told apart any more */
  #lost = false;

  constructor(rpc: PiRpc) {
    this.#rpc = rpc;
  }

  get turns(): readonly (string | undefined)[] {
    return this.#turns;
  }

  /** A fresh process: nothing recorded yet. */
  async prime(): Promise<void> {
    this.#turns = [];
    this.#lost = false;
    await this.reposition();
  }

  /**
   * Puts the cursor on the session's newest user message (`get_fork_messages` lists them in
   * append order without assistant bodies). Nothing after it is a user message, so the next
   * `record()` finds the next prompt first. No user message → no cursor → read from the start.
   */
  async reposition(): Promise<void> {
    const forks = await this.#rpc.data<{ messages?: { entryId: string }[] }>({ type: "get_fork_messages" });
    this.#cursor = forks?.messages?.at(-1)?.entryId;
  }

  /** The last `turns` turns are gone from the session. */
  dropped(turns: number): void {
    this.#turns = this.#turns.slice(0, Math.max(0, this.#turns.length - turns));
  }

  /** A send that never started a run (`handled`, rejected): it counts, but there's nothing to drop. */
  skip(): void {
    this.#turns.push(undefined);
  }

  /** Called after each turn settles: reads what the turn appended. */
  async record(): Promise<void> {
    const data = await this.#rpc.data<EntriesData>(this.#cursor === undefined ? { type: "get_entries" } : { type: "get_entries", since: this.#cursor });
    if (!data) {
      this.#lost = true;
      this.#turns = [];
      return;
    }
    const entries = data.entries ?? [];
    this.#turns.push(firstUserEntry(entries));
    this.#cursor = entries.at(-1)?.id ?? this.#cursor;
  }

  /**
   * Entry ids (undefined = a send with nothing to drop) for every turn on the active branch,
   * oldest first. Only reads the session when `needed` exceeds what this process recorded.
   */
  async starts(needed: number): Promise<(string | undefined)[]> {
    if (!this.#lost && needed <= this.#turns.length) return [...this.#turns];
    const data = await this.#rpc.data<EntriesData>({ type: "get_entries" });
    if (!data) throw new Error("pi did not answer get_entries; cannot locate the turns to roll back");
    const branch = activeBranch(data.entries ?? [], data.leafId);
    const recorded = this.#lost ? [] : this.#turns;
    const firstRecorded = recorded.find((id) => id !== undefined);
    const boundary = firstRecorded === undefined ? -1 : branch.findIndex((entry) => entry.id === firstRecorded);
    if (firstRecorded !== undefined && boundary === -1) return branchTurnStarts(branch);
    const older = branchTurnStarts(boundary === -1 ? branch : branch.slice(0, boundary));
    return [...older, ...recorded];
  }
}
