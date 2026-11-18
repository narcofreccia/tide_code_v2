/** One turn the server records for this session; `native` is its Codex turn id when it has one. */
export interface LedgerEntry {
  native?: string;
}

/** What `rollback(n)` has to do on the Codex side. */
export interface RollbackPlan {
  /** entries of this process among the last n, oldest first */
  local: LedgerEntry[];
  /** turns older than this process (resumed or forked history) among the last n */
  older: number;
  /** Codex turns among the last n: the native local ones plus every older one */
  native: number;
}

/**
 * The turns of this session in the order the server records them, oldest first. Each `send`
 * is one entry with its Codex turn id. A harness turn opened for a sub-agent's request is an
 * entry with no Codex turn: the server counts it when it rolls back, Codex has nothing to drop.
 * A harness turn the server dismisses (never recorded) is removed again.
 */
export class TurnLedger {
  #entries: LedgerEntry[] = [];

  add(native?: string): LedgerEntry {
    const entry: LedgerEntry = native !== undefined ? { native } : {};
    this.#entries.push(entry);
    return entry;
  }

  remove(entry: LedgerEntry): void {
    const i = this.#entries.indexOf(entry);
    if (i >= 0) this.#entries.splice(i, 1);
  }

  plan(turns: number): RollbackPlan {
    const local = this.#entries.slice(Math.max(0, this.#entries.length - turns));
    const older = Math.max(0, turns - this.#entries.length);
    return { local, older, native: local.filter((entry) => entry.native !== undefined).length + older };
  }

  /** Forgets the last `count` entries (they were rolled back). */
  drop(count: number): void {
    this.#entries.splice(Math.max(0, this.#entries.length - count));
  }
}
