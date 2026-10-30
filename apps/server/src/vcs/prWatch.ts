import { newId as defaultNewId, type Activity, type Command, type EventRecord, type PrDetail, type PullRequest } from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import { threadCwd } from "../provider/sessions.ts";
import type { ForgeResolver } from "./forge/resolver.ts";
import type { Forge } from "./forge/types.ts";
import { checksRecovered, LOG_LINES, newlyFailed, prWake } from "./prWake.ts";

export type CancelTimer = () => void;

export interface PrWatcherOptions {
  engine: Engine;
  /** which forge serves a thread's checkout */
  forges: ForgeResolver;
  now?: () => number;
  /** one-shot timer; the watcher re-arms itself after every poll */
  schedule?: (fn: () => void, ms: number) => CancelTimer;
  intervalMs?: number;
  /** consecutive forge (gh) failures after which a thread stops being watched */
  maxFailures?: number;
  newId?: () => string;
  log?: (msg: string, data?: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 2 * 60_000;
const DEFAULT_MAX_FAILURES = 8;

const realTimer = (fn: () => void, ms: number): CancelTimer => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/**
 * Polls a thread's pull request through its forge (`gh pr view` + line comments) and reports it
 * as `pr.update`, so checks, review decision and the forge's `mergedAt` reach the model (a merge
 * seen here settles the thread through the settlement reactor). While the thread is watched
 * (`thread.prWatch`), a newly failed check, a changes-requested review, new comments or a
 * conflict wake it with one specific `turn.request` per poll (queued behind a running turn by
 * the decider); CI recovering only leaves an info note. Watching ends once the PR is merged or
 * closed, or after `maxFailures` consecutive forge failures.
 */
export class PrWatcher {
  #engine: Engine;
  #forges: ForgeResolver;
  #now: () => number;
  #schedule: (fn: () => void, ms: number) => CancelTimer;
  #intervalMs: number;
  #maxFailures: number;
  #newId: () => string;
  #log: (msg: string, data?: unknown) => void;
  #failures = new Map<string, number>();
  #refreshing = new Map<string, Promise<void>>();
  #inflight = new Set<Promise<unknown>>();
  #cancel: CancelTimer | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor(options: PrWatcherOptions) {
    this.#engine = options.engine;
    this.#forges = options.forges;
    this.#now = options.now ?? (() => Date.now());
    this.#schedule = options.schedule ?? realTimer;
    this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.#newId = options.newId ?? (() => defaultNewId());
    this.#log = options.log ?? (() => undefined);
  }

  start(): void {
    this.#unsubscribe ??= this.#engine.subscribe((record) => this.#onRecord(record));
    if (this.#cancel === undefined) this.#arm();
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#cancel?.();
    this.#cancel = undefined;
  }

  async drain(): Promise<void> {
    for (let i = 0; i < 10_000; i++) {
      await this.#engine.drain();
      if (this.#inflight.size === 0) return;
      await Promise.allSettled([...this.#inflight]);
    }
    throw new Error("pr watcher did not drain");
  }

  #arm(): void {
    this.#cancel = this.#schedule(() => {
      this.#cancel = undefined;
      void this.tick().finally(() => {
        if (this.#unsubscribe !== undefined && this.#cancel === undefined) this.#arm();
      });
    }, this.#intervalMs);
  }

  /** Refreshes every watched thread once; exposed so tests poll without a timer. */
  async tick(): Promise<void> {
    const watched = Object.values(this.#engine.getModel().threads).filter((t) => t.prWatch !== undefined && t.archivedAt === undefined);
    await Promise.all(watched.map((t) => this.refresh(t.id)));
  }

  #onRecord(record: EventRecord): void {
    const event = record.event;
    if (event.type !== "pr.watch-changed") return;
    if (event.enabled) void this.refresh(event.threadId);
    else this.#failures.delete(event.threadId);
  }

  /** One forge round-trip for the thread's PR; concurrent calls for the same thread share it. */
  refresh(threadId: string): Promise<void> {
    const pending = this.#refreshing.get(threadId);
    if (pending) return pending;
    const run = this.#refresh(threadId)
      .catch((err: unknown) => this.#log("[pr-watch] refresh failed", err))
      .finally(() => this.#refreshing.delete(threadId));
    this.#refreshing.set(threadId, run);
    const tracked = run.finally(() => this.#inflight.delete(tracked));
    this.#inflight.add(tracked);
    return run;
  }

  async #refresh(threadId: string): Promise<void> {
    const model = this.#engine.getModel();
    const thread = model.threads[threadId];
    const project = thread ? model.projects[thread.projectId] : undefined;
    const pr = thread?.pr;
    if (!thread || !project || !pr) return;
    const cwd = threadCwd(thread, project);
    let detail: PrDetail;
    let forge: Forge | undefined;
    try {
      forge = (await this.#forges.forDir(cwd))?.forge;
      if (forge === undefined) throw new Error("no supported forge (GitHub) serves this repository's origin");
      detail = await forge.prDetail(cwd, pr.number);
      this.#failures.delete(threadId);
    } catch (err) {
      const failures = (this.#failures.get(threadId) ?? 0) + 1;
      this.#failures.set(threadId, failures);
      this.#log("[pr-watch] forge failed", { threadId, failures, err });
      if (failures >= this.#maxFailures && this.#engine.getModel().threads[threadId]?.prWatch !== undefined) {
        this.#failures.delete(threadId);
        await this.#send({ type: "pr.watch", threadId, enabled: false });
        await this.#note(threadId, `Stopped watching pull request #${pr.number}: gh failed ${failures} times in a row (${err instanceof Error ? err.message : String(err)})`);
      }
      return;
    }
    // the stored URL stays authoritative (a linked PR may live in another repo); everything else is fresh
    const next: PullRequest = { ...detail.pr, url: pr.url, number: pr.number, updatedAt: this.#now() };
    await this.#send({ type: "pr.update", threadId, pr: next });
    if (thread.prWatch === undefined) return;
    if (next.state !== "open") {
      await this.#send({ type: "pr.watch", threadId, enabled: false });
      return;
    }
    if (checksRecovered(pr, next)) await this.#note(threadId, `CI on pull request #${pr.number} passes again.`);
    const firstFailed = newlyFailed(pr, next)[0];
    const log = firstFailed !== undefined ? await forge?.failedLog?.(cwd, firstFailed, LOG_LINES)?.catch(() => undefined) : undefined;
    const wake = prWake(pr, { ...detail, pr: next }, log);
    if (wake === undefined) return;
    await this.#send({ type: "turn.request", threadId, text: wake.text, notification: { source: "pr", summary: wake.summary } });
  }

  async #note(threadId: string, text: string): Promise<void> {
    const turnId = this.#engine.getModel().threads[threadId]?.latestTurnId;
    if (turnId === undefined) return;
    const at = this.#now();
    const activity: Activity = { id: this.#newId(), threadId, turnId, kind: "info", text, createdAt: at, updatedAt: at };
    await this.#send({ type: "activity.upsert", activity });
  }

  async #send(command: Command): Promise<void> {
    try {
      await this.#engine.dispatch(command);
    } catch (err) {
      this.#log(`[pr-watch] ${command.type} rejected`, err);
    }
  }
}
