import type { EventRecord, ExpertsPhase, ExpertsSession, ReadModel } from "@tide/contracts";
import type { Engine } from "../../orchestration/engine.ts";
import type { Judge } from "../judge.ts";
import { clip, Inflight, recordCommand, usable } from "./siteKit.ts";

export interface ExpertsSiteOptions {
  engine: Engine;
  judge: Pick<Judge, "ask" | "enabled">;
  grayZone: () => { low: number; high: number };
  /** settings.decisions.expertsAutoAdvance, read live */
  autoAdvance: () => boolean;
  now?: () => number;
  log?: (msg: string, data?: unknown) => void;
}

const INSTRUCTIONS = "The experts have converged: their findings agree, or the remaining disagreements are explicit and would not change with more discussion.";
export const NEXT_PHASE: Partial<Record<ExpertsPhase, ExpertsPhase>> = { exploring: "discussing", discussing: "synthesizing" };

function state(model: ReadModel, s: ExpertsSession): Record<string, unknown> {
  const findings = s.findingIds.map((id) => model.expertsFindings[id]).filter((f) => f !== undefined);
  const messages = s.messageIds.map((id) => model.expertsMessages[id]).filter((m) => m !== undefined);
  return {
    topic: clip(s.topic, 400),
    phase: s.phase,
    findings: Object.fromEntries(s.experts.map((e) => [e.key, findings.filter((f) => f.author === e.key).slice(-2).map((f) => clip(f.text, 500))])),
    lastMessages: Object.fromEntries(s.experts.map((e) => [e.key, messages.filter((m) => m.from === e.key).slice(-1).map((m) => clip(m.text, 300))])),
  };
}

/**
 * Site `experts`: when every expert is idle during exploring / discussing and new findings arrived
 * since the last question for the session, one yes/no asks whether they converged. The verdict is
 * recorded for the Board's "Move to <next phase>?" chip; with the user's opt-in
 * (`expertsAutoAdvance`) a Jev "yes" at ≥ high advances one phase, once per findings count.
 */
export class ExpertsSite {
  #engine: Engine;
  #judge: ExpertsSiteOptions["judge"];
  #grayZone: () => { low: number; high: number };
  #autoAdvance: () => boolean;
  #now: () => number;
  #log: (msg: string, data?: unknown) => void;
  /** session id → findings count at the last question */
  #asked = new Map<string, number>();
  #inflight = new Inflight();
  #unsubscribe: (() => void) | undefined;

  constructor(options: ExpertsSiteOptions) {
    this.#engine = options.engine;
    this.#judge = options.judge;
    this.#grayZone = options.grayZone;
    this.#autoAdvance = options.autoAdvance;
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
    throw new Error("experts site did not drain");
  }

  #onRecord(record: EventRecord): void {
    const event = record.event;
    if (event.type !== "experts.expert-status-changed" || event.status !== "idle") return;
    try {
      if (!this.#judge.enabled("experts")) return;
      const session = this.#engine.getModel().expertsSessions[event.sessionId];
      if (session === undefined || (session.phase !== "exploring" && session.phase !== "discussing")) return;
      const bound = session.experts.filter((e) => e.threadId !== undefined);
      if (bound.length === 0 || !bound.every((e) => e.status === "idle")) return;
      const count = session.findingIds.length;
      if (count === 0 || count <= (this.#asked.get(session.id) ?? 0)) return;
      this.#asked.set(session.id, count);
      this.#inflight.track(this.#ask(session.id, count));
    } catch (err) {
      this.#log("[experts-site] trigger failed", err);
    }
  }

  async #ask(sessionId: string, count: number): Promise<void> {
    try {
      const model = this.#engine.getModel();
      const session = model.expertsSessions[sessionId];
      if (session === undefined) return;
      const phaseAsked = session.phase;
      const [verdict] = await this.#judge.ask({ site: "experts", id: `experts:${sessionId}:${count}`, kind: "yes-no", state: state(model, session), instructions: INSTRUCTIONS });
      const v = usable("experts", verdict, this.#now());
      if (v === undefined) return;
      await this.#engine.dispatch(recordCommand("experts", sessionId, v));
      const now = this.#engine.getModel().expertsSessions[sessionId];
      const next = now === undefined ? undefined : NEXT_PHASE[now.phase];
      if (now === undefined || next === undefined || now.phase !== phaseAsked) return;
      if (now.findingIds.length !== count) return; // newer findings: the verdict is stale
      if (this.#autoAdvance() && v.source === "jev" && (v.score ?? 0) >= this.#grayZone().high) {
        await this.#engine.dispatch({ type: "experts.set-phase", sessionId, phase: next });
      }
    } catch (err) {
      this.#log("[experts-site] verdict failed", err);
    }
  }
}
