import { randomUUID } from "node:crypto";
import type { DecisionClient } from "./client.ts";
import { wireQuestions } from "./budget.ts";
import { noneVerdict, type Ask, type JudgeBackend, type JudgeCall, type JudgeVerdict } from "./judge.ts";
import type { Answer } from "./wire.ts";

/** Jev's answer as a verdict; `Answer.confidence` is the calibrated confidence the gray zone reads. */
export function answerToVerdict(id: string, ask: Ask, answer: Answer): JudgeVerdict {
  const base = { id, confidence: Math.max(0, Math.min(1, answer.confidence)), source: "jev" as const, tokens: 0, elapsedMs: 0 };
  switch (ask.kind) {
    case "yes-no": {
      const p = Number(answer.value);
      return { ...base, label: p >= 0.5 ? "true" : "false", score: Math.max(0, Math.min(1, p)) };
    }
    case "label":
      return { ...base, label: String(answer.value) };
    case "score": {
      const level = Number(answer.value);
      const top = Math.max(1, ask.levels.length - 1);
      return { ...base, label: String(Math.round(level)), score: Math.max(0, Math.min(1, level / top)) };
    }
  }
}

/**
 * The Jev backend: each pre-packed judge call becomes one System One request (no re-splitting).
 * A call's tokens and cost are shared evenly by its verdicts so the ledger sums stay exact.
 */
export class JevBackend implements JudgeBackend {
  readonly name = "jev" as const;
  #client: Pick<DecisionClient, "askMany" | "enabled">;
  #newId: () => string;

  constructor(client: Pick<DecisionClient, "askMany" | "enabled">, newId: () => string = randomUUID) {
    this.#client = client;
    this.#newId = newId;
  }

  available(): boolean {
    return this.#client.enabled;
  }

  async ask(calls: JudgeCall[], options: { timeoutMs?: number } = {}): Promise<JudgeVerdict[]> {
    if (calls.length === 0) return [];
    const site = calls[0]?.site;
    let outcomes;
    try {
      outcomes = await this.#client.askMany(
        calls.map((c) => ({ state: c.state, questions: wireQuestions(c.units) })),
        site,
        options.timeoutMs,
      );
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      return calls.flatMap((c) => c.units.map((u) => noneVerdict(u.id, message)));
    }
    const out: JudgeVerdict[] = [];
    calls.forEach((call, i) => {
      const outcome = outcomes[i];
      if (outcome === undefined || outcome.error !== undefined || outcome.answers === undefined) {
        const message = outcome?.error?.message ?? "no response";
        for (const u of call.units) out.push({ ...noneVerdict(u.id, message), elapsedMs: outcome?.elapsedMs ?? 0 });
        return;
      }
      const n = Math.max(1, call.units.length);
      const callId = this.#newId();
      const total = outcome.record?.inputTokens ?? 0;
      const share = Math.floor(total / n);
      const costUsd = (outcome.record?.costUsd ?? 0) / n;
      call.units.forEach((u, j) => {
        const answer = outcome.answers?.[`q${j}`];
        const tokens = share + (j === 0 ? total - share * n : 0);
        const shared = { tokens, costUsd, elapsedMs: outcome.elapsedMs, callId, ...(outcome.record?.model !== undefined ? { model: outcome.record.model } : {}) };
        out.push(answer === undefined ? { ...noneVerdict(u.id, "no answer"), ...shared } : { ...answerToVerdict(u.id, u.ask, answer), ...shared });
      });
    });
    return out;
  }
}
