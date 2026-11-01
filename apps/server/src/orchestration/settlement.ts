import { hasBackgroundChildren, type EventRecord, type ReadModel, type SettleReason, type Thread } from "@tide/contracts";
import type { SettingsStore } from "../settings.ts";
import { descendantsOf } from "./decider/descendants.ts";
import { CommandError, type Engine } from "./engine.ts";
import type { CancelTimer } from "./limits.ts";

export interface SettlementReactorOptions {
  engine: Engine;
  settings: Pick<SettingsStore, "get">;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => CancelTimer;
  intervalMs?: number;
  log?: (msg: string, data?: unknown) => void;
}

const DAY_MS = 86_400_000;
const DEFAULT_INTERVAL_MS = 10 * 60_000;

const realTimer = (fn: () => void, ms: number): CancelTimer => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/**
 * Closes threads from the inbox on the server's own rules: the PR / branch merged, or nothing
 * happened for `inbox.autoSettleAfterDays`. The decider decides what may be settled (never a
 * running, waiting, pinned or opted-out thread); this only watches events and the clock.
 */
export class SettlementReactor {
  #engine: Engine;
  #settings: SettlementReactorOptions["settings"];
  #now: () => number;
  #schedule: (fn: () => void, ms: number) => CancelTimer;
  #intervalMs: number;
  #log: (msg: string, data?: unknown) => void;
  #cancel: CancelTimer | undefined;
  #unsubscribe: (() => void) | undefined;
  #running = false;
  /** threads whose PR was already seen merged: later syncs of the same merged PR (which carry the same forge `mergedAt`) must not settle again */
  #prMerged = new Set<string>();

  constructor(options: SettlementReactorOptions) {
    this.#engine = options.engine;
    this.#settings = options.settings;
    this.#now = options.now ?? (() => Date.now());
    this.#schedule = options.schedule ?? realTimer;
    this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#log = options.log ?? (() => undefined);
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    for (const t of Object.values(this.#engine.getModel().threads)) if (t.pr?.state === "merged") this.#prMerged.add(t.id);
    this.#unsubscribe = this.#engine.subscribe((record) => this.#onEvent(record));
    this.#arm();
  }

  stop(): void {
    this.#running = false;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#cancel?.();
    this.#cancel = undefined;
  }

  #arm(): void {
    if (!this.#running) return;
    this.#cancel = this.#schedule(() => {
      void this.tick().finally(() => this.#arm());
    }, this.#intervalMs);
  }

  #onEvent(record: EventRecord): void {
    const event = record.event;
    let threadId: string;
    let reason: SettleReason;
    if (event.type === "pr.updated") {
      if (event.pr.state !== "merged" || this.#prMerged.has(event.threadId)) return;
      this.#prMerged.add(event.threadId);
      threadId = event.threadId;
      reason = "pr-merged";
    } else if (event.type === "merge.completed") {
      threadId = event.threadId;
      reason = "merged-back";
    } else return;
    if (!this.#settings.get().inbox.autoSettleOnMerge) return;
    // only the event that made the thread merged; later PR syncs must not undo a manual unsettle
    const thread = this.#engine.getModel().threads[threadId];
    // the projector stamps the forge's merge time when the PR carries one (R10), else the poll time
    const mergedAt = event.type === "pr.updated" ? (event.pr.mergedAt ?? event.pr.updatedAt) : event.at;
    if (thread === undefined || thread.mergedAt !== mergedAt) return;
    void this.#settle(threadId, reason);
  }

  async #settle(threadId: string, reason: SettleReason): Promise<boolean> {
    try {
      await this.#engine.dispatch({ type: "thread.settle", threadId, reason });
      return true;
    } catch (err) {
      if (err instanceof CommandError && (err.code === "conflict" || err.code === "not-found")) {
        this.#log("[settlement] settle refused", { threadId, reason, code: err.code });
      } else {
        this.#log("[settlement] settle failed", { threadId, reason, err });
      }
      return false;
    }
  }

  /** One pass over the read model; returns the ids it settled. */
  async tick(): Promise<string[]> {
    const days = this.#settings.get().inbox.autoSettleAfterDays;
    if (!(days > 0)) return [];
    const cutoff = this.#now() - days * DAY_MS;
    const model = this.#engine.getModel();
    const settled: string[] = [];
    for (const thread of Object.values(model.threads)) {
      if (!eligible(model, thread, cutoff)) continue;
      if (await this.#settle(thread.id, "inactive")) settled.push(thread.id);
    }
    return settled;
  }
}

function eligible(model: ReadModel, thread: Thread, cutoff: number): boolean {
  if (thread.archivedAt !== undefined || thread.settledAt !== undefined) return false;
  if (thread.pinned === true || thread.autoSettle === false) return false;
  if (thread.status !== "idle" || thread.attention !== undefined) return false;
  // background sub-agents still working: not idle, whatever the settled turn says
  if (hasBackgroundChildren(model, thread.id)) return false;
  if (lastActiveAt(model, thread) > cutoff) return false;
  if (descendantsOf(model, thread.id).some((d) => d.status === "running")) return false;
  // a delegate whose parent works, or an expert / lead whose session still works, is part of that work
  const parentId = thread.delegatedBy ?? thread.parentThreadId;
  if (thread.role === "delegate" && parentId !== undefined && model.threads[parentId]?.status === "running") return false;
  if ((thread.role === "expert" || thread.role === "lead") && thread.expertsSessionId !== undefined) {
    if (Object.values(model.threads).some((t) => t.expertsSessionId === thread.expertsSessionId && t.status === "running")) return false;
  }
  return true;
}

/**
 * When the thread last did anything. A sub-agent's rows do not bump `thread.updatedAt`, so a
 * thread whose background agents reported (or were closed as lost) counts from their last row,
 * not from the earlier settle of the turn that launched them.
 */
function lastActiveAt(model: ReadModel, thread: Thread): number {
  let last = thread.updatedAt;
  for (const entry of model.threadTimeline[thread.id] ?? []) {
    if (entry.kind !== "activity") continue;
    const a = model.activities[entry.id];
    if (a?.kind === "child" || (a?.kind === "tool" && a.parentToolUseId != null)) last = Math.max(last, a.updatedAt);
  }
  return last;
}
