import type { EventRecord, ReadModel, Thread } from "@tide/contracts";
import type { Engine } from "../../orchestration/engine.ts";
import type { Judge } from "../judge.ts";
import { clip, Inflight, recordCommand, usable } from "./siteKit.ts";

export interface DelegatesSiteOptions {
  engine: Engine;
  judge: Pick<Judge, "ask" | "enabled">;
  now?: () => number;
  log?: (msg: string, data?: unknown) => void;
}

const REVIEWER = /review|test|qa/i;
const REVIEW_LABELS = { pass: "the task succeeded: the review/test found nothing blocking", fail: "the review/test found a problem", inconclusive: "no clear result either way" };
const WORK_LABELS = { done: "the task was completed", blocked: "the delegate could not proceed", "needs-user": "it stopped waiting for an answer from the user", failed: "it errored or gave up" };

function firstUserText(model: ReadModel, threadId: string): string {
  for (const id of model.threadMessages[threadId] ?? []) {
    const m = model.messages[id];
    if (m?.role === "user") return m.text;
  }
  return "";
}

function lastReply(model: ReadModel, threadId: string): string {
  const ids = model.threadMessages[threadId] ?? [];
  for (let i = ids.length - 1; i >= 0; i--) {
    const m = model.messages[ids[i] as string];
    if (m?.role === "assistant" && m.text.length > 0) return m.text;
  }
  return "";
}

function pendingQuestion(model: ReadModel, threadId: string): string | undefined {
  for (const e of model.threadTimeline[threadId] ?? []) {
    const a = e.kind === "activity" ? model.activities[e.id] : undefined;
    if (a?.kind === "user-input" && a.status === "pending") return clip(a.questions.map((q) => q.text).join(" / "), 400);
  }
  return undefined;
}

/**
 * Site `delegates`: when a delegate's turn settles, one small label question says how the task
 * ended. The verdict lands on the thread (`Thread.judge`); the parent's wake-up and the rail read it.
 */
export class DelegatesSite {
  #engine: Engine;
  #judge: DelegatesSiteOptions["judge"];
  #now: () => number;
  #log: (msg: string, data?: unknown) => void;
  #inflight = new Inflight();
  #unsubscribe: (() => void) | undefined;

  constructor(options: DelegatesSiteOptions) {
    this.#engine = options.engine;
    this.#judge = options.judge;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? ((msg, data) => (data === undefined ? console.error(msg) : console.error(msg, data)));
  }

  start(): void {
    this.#unsubscribe ??= this.#engine.subscribe((record) => this.#onRecord(record));
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  async drain(): Promise<void> {
    for (let i = 0; i < 1_000; i++) {
      await this.#engine.drain();
      if (this.#inflight.size === 0) return;
      await this.#inflight.all();
    }
    throw new Error("delegates site did not drain");
  }

  #onRecord(record: EventRecord): void {
    const event = record.event;
    if (event.type !== "turn.settled") return;
    try {
      if (!this.#judge.enabled("delegates")) return;
      const model = this.#engine.getModel();
      const child = model.threads[event.threadId];
      if (child?.delegatedBy === undefined || child.status === "running") return;
      this.#inflight.track(this.#ask(model, child, event.turnId, event.status, event.error));
    } catch (err) {
      this.#log("[delegates] trigger failed", err);
    }
  }

  async #ask(model: ReadModel, child: Thread, turnId: string, outcome: string, error: string | undefined): Promise<void> {
    try {
      const pending = pendingQuestion(model, child.id);
      const reviewer = REVIEWER.test(child.delegateRole ?? "");
      const [verdict] = await this.#judge.ask({
        site: "delegates",
        id: `delegate:${child.id}:${turnId}`,
        kind: "label",
        state: {
          task: clip(firstUserText(model, child.id), 600),
          lastReply: clip(lastReply(model, child.id), 1500),
          outcome,
          ...(error !== undefined ? { error: clip(error, 300) } : {}),
          ...(pending !== undefined ? { pendingQuestion: pending } : {}),
        },
        instructions: "Classify how this delegated task ended.",
        labels: reviewer ? REVIEW_LABELS : WORK_LABELS,
      });
      const v = usable("delegates", verdict, this.#now());
      if (v?.label === undefined || this.#engine.getModel().threads[child.id] === undefined) return;
      await this.#engine.dispatch(recordCommand("thread", child.id, v));
    } catch (err) {
      this.#log("[delegates] verdict failed", err);
    }
  }
}
