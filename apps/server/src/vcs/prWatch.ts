import { newId as defaultNewId, type Activity, type Command, type EventRecord, type PullRequest } from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import { threadCwd } from "../provider/sessions.ts";
import type { GhLike, PrStatus } from "./gh.ts";

export type CancelTimer = () => void;

export interface PrWatcherOptions {
  engine: Engine;
  gh: GhLike;
  now?: () => number;
  /** one-shot timer; the watcher re-arms itself after every poll */
  schedule?: (fn: () => void, ms: number) => CancelTimer;
  intervalMs?: number;
  /** consecutive gh failures after which a thread stops being watched */
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

/** What changed on the PR that the agent should act on; empty = nothing worth waking it for. */
export function prChanges(previous: PullRequest, next: PullRequest): string[] {
  const changes: string[] = [];
  if (next.checks === "failure" && previous.checks !== "failure") changes.push("CI checks failed");
  if (previous.comments !== undefined && next.comments !== undefined && next.comments > previous.comments) {
    const n = next.comments - previous.comments;
    changes.push(`${n} new comment${n === 1 ? "" : "s"} or review${n === 1 ? "" : "s"}`);
  }
  if (next.mergeable === false && previous.mergeable !== false) changes.push("the branch now conflicts with its base");
  return changes;
}

/**
 * Polls a thread's pull request through `gh` and reports it as `pr.update`. While the thread is
 * watched (`thread.prWatch`), a CI failure, new comments or a conflict wake it with a
 * `turn.request` (queued behind a running turn by the decider). Watching ends once the PR is
 * merged or closed, or after `maxFailures` consecutive gh failures.
 */
export class PrWatcher {
  #engine: Engine;
  #gh: GhLike;
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
    this.#gh = options.gh;
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

  /** One gh round-trip for the thread's PR; concurrent calls for the same thread share it. */
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
    if (!thread || !project || !pr || this.#gh.prStatus === undefined) return;
    let status: PrStatus;
    try {
      if (!(await this.#gh.hasGh())) throw new Error("the GitHub CLI is not installed");
      status = await this.#gh.prStatus(threadCwd(thread, project), pr.number);
      this.#failures.delete(threadId);
    } catch (err) {
      const failures = (this.#failures.get(threadId) ?? 0) + 1;
      this.#failures.set(threadId, failures);
      this.#log("[pr-watch] gh failed", { threadId, failures, err });
      if (failures >= this.#maxFailures && this.#engine.getModel().threads[threadId]?.prWatch !== undefined) {
        this.#failures.delete(threadId);
        await this.#send({ type: "pr.watch", threadId, enabled: false });
        await this.#note(threadId, `Stopped watching pull request #${pr.number}: gh failed ${failures} times in a row (${err instanceof Error ? err.message : String(err)})`);
      }
      return;
    }
    const next: PullRequest = {
      url: pr.url,
      number: pr.number,
      state: status.state,
      updatedAt: this.#now(),
      ...(status.checks !== undefined ? { checks: status.checks } : {}),
      ...(status.mergeable !== undefined ? { mergeable: status.mergeable } : {}),
      comments: status.comments,
    };
    await this.#send({ type: "pr.update", threadId, pr: next });
    if (thread.prWatch === undefined) return;
    if (next.state !== "open") {
      await this.#send({ type: "pr.watch", threadId, enabled: false });
      return;
    }
    const changes = prChanges(pr, next);
    if (changes.length === 0) return;
    const summary = `PR #${pr.number}: ${changes.join(", ")}`;
    await this.#send({
      type: "turn.request",
      threadId,
      text: `Pull request #${pr.number} changed: ${changes.join("; ")}. Look at it (\`gh pr view ${pr.number} --comments\`, \`gh pr checks ${pr.number}\`) and address what needs addressing.`,
      notification: { source: "pr", summary },
    });
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
