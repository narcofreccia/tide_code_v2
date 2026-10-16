import type { EventRecord, Handoff, HandoffJudge, JudgeSource, ReadModel } from "@tide/contracts";
import type { Engine } from "../../orchestration/engine.ts";
import { CommandError } from "../../orchestration/engine.ts";
import { handoffBudget, handoffCandidates, handoffCapFromEnv, selectHandoffRanked, type HandoffItem } from "../../orchestration/handoff/select.ts";
import type { Judge, JudgeVerdict, PerItemQuestion } from "../judge.ts";

export const TASK_CHARS = 400;
export const ITEM_CHARS = 240;

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

export interface HandoffSiteOptions {
  engine: Engine;
  judge: Pick<Judge, "ask" | "enabled">;
  /** defaults to `TIDE_HANDOFF_TOKEN_CAP` (the engine's cap, so the budget matches the recorded one) */
  handoffCap?: number | undefined;
  now?: () => number;
  log?: (msg: string, data?: unknown) => void;
}

/** The per-item question for a handoff's non-priority items, or undefined when there is nothing to rank. */
export function buildHandoffQuestion(model: ReadModel, handoff: Handoff): { question: PerItemQuestion; rest: HandoffItem[] } | undefined {
  const { options, priority, rest } = handoffCandidates(model, handoff);
  if (rest.length === 0) return undefined;
  const all = [...priority, ...rest].sort((a, b) => a.pos - b.pos);
  const users = all.filter((i) => i.kind === "user");
  const turnNo = new Map(options.turns.map((t, i) => [t.id, i + 1]));
  const question: PerItemQuestion = {
    kind: "per-item",
    site: "handoff",
    id: `handoff:${handoff.id}`,
    shared: { task: clip(users[0]?.text ?? "", TASK_CHARS), latest: clip(users[users.length - 1]?.text ?? "", TASK_CHARS) },
    items: rest.map((i) => ({ key: String(i.pos), state: { kind: i.kind, turn: turnNo.get(i.turnId) ?? 0, text: clip(i.text, ITEM_CHARS) } })),
    instructions: "Decide whether this item is needed for the next harness to continue the task.",
    labels: { keep: "needed to continue", drop: "noise or superseded" },
  };
  return { question, rest };
}

/** keep -> score ?? confidence, drop -> 1 - that, no verdict -> 0.5. Keyed by item `pos`. */
export function rankFrom(rest: HandoffItem[], verdicts: JudgeVerdict[], questionId: string): Map<number, number> {
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  const rank = new Map<number, number>();
  for (const item of rest) {
    const v = byId.get(`${questionId}:${item.pos}`);
    if (v === undefined || v.source === "none" || (v.label !== "keep" && v.label !== "drop")) {
      rank.set(item.pos, 0.5);
      continue;
    }
    const p = v.score ?? v.confidence;
    rank.set(item.pos, v.label === "keep" ? p : 1 - p);
  }
  return rank;
}

/**
 * Site `handoff`: when a recorded handoff had to omit turns, the judge ranks the items the recency
 * selection would fill the budget with, and the handoff is re-selected in that order
 * (`handoff.refine`). Only while the handoff is still pending: the provider reactor waits briefly
 * for `pending(id)` before delivering; a refine that lands later is rejected (`conflict`).
 */
export class HandoffSite {
  #engine: Engine;
  #judge: HandoffSiteOptions["judge"];
  #cap: number | undefined;
  #now: () => number;
  #log: (msg: string, data?: unknown) => void;
  #unsubscribe: (() => void) | undefined;
  #pending = new Map<string, Promise<void>>();
  #loggedConflict = false;

  constructor(options: HandoffSiteOptions) {
    this.#engine = options.engine;
    this.#judge = options.judge;
    this.#cap = "handoffCap" in options ? options.handoffCap : handoffCapFromEnv();
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

  /** Resolves when the refine for this handoff (or its failure) is done; undefined when none is running. */
  pending(handoffId: string): Promise<void> | undefined {
    return this.#pending.get(handoffId);
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.#pending.values()]);
    await this.#engine.drain();
  }

  #onRecord(record: EventRecord): void {
    const event = record.event;
    if (event.type !== "handoff.recorded" || event.handoff.omittedTurnIds.length === 0) return;
    try {
      if (!this.#judge.enabled("handoff")) return;
      // built now, against the model the handoff was selected from
      const built = buildHandoffQuestion(this.#engine.getModel(), event.handoff);
      if (built === undefined) return;
      const id = event.handoff.id;
      const run = this.#refine(event.handoff, built.question, built.rest)
        .catch((err: unknown) => this.#log("[handoff-site] refine failed", err))
        .finally(() => this.#pending.delete(id));
      this.#pending.set(id, run);
    } catch (err) {
      this.#log("[handoff-site] could not build the question", err);
    }
  }

  async #refine(handoff: Handoff, question: PerItemQuestion, rest: HandoffItem[]): Promise<void> {
    const verdicts = await this.#judge.ask(question);
    const answered = verdicts.filter((v) => v.source !== "none");
    if (answered.length === 0) return;
    const model = this.#engine.getModel();
    const { options } = handoffCandidates(model, handoff);
    const source = model.threads[handoff.sourceThreadId];
    const budgetBytes = handoffBudget({ cap: this.#cap, window: source?.contextUsage?.window });
    const selection = selectHandoffRanked(model, { ...options, budgetBytes }, rankFrom(rest, verdicts, question.id));
    const src: JudgeSource = answered.some((v) => v.source === "fallback") ? "fallback" : "jev";
    const judge: HandoffJudge = {
      kept: selection.chosen,
      dropped: selection.items - selection.chosen,
      source: src,
      confidence: answered.reduce((sum, v) => sum + v.confidence, 0) / answered.length,
      at: this.#now(),
    };
    try {
      await this.#engine.dispatch({
        type: "handoff.refine",
        handoffId: handoff.id,
        text: selection.text,
        coveredTurnIds: selection.coveredTurnIds,
        omittedTurnIds: selection.omittedTurnIds,
        judge,
      });
    } catch (err) {
      if (!(err instanceof CommandError) || err.code !== "conflict") throw err;
      if (this.#loggedConflict) return;
      this.#loggedConflict = true;
      this.#log("[handoff-site] refine arrived after delivery; the recency selection was used", err.message);
    }
  }
}
