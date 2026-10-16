import type { JudgeSite } from "@tide/contracts";
import { DecisionLimitError, estimateTokens, requestFits, type Limits } from "./client.ts";
import type { Ask, JudgeCall, JudgeUnit, PerItemQuestion, SingleQuestion } from "./judge.ts";
import { choice, noul, score, type Question, type Questions, type State } from "./wire.ts";

/**
 * Budgeting for the judge. Each site has a state cap (tokens) and an item cap per call. Items
 * are grouped greedily into calls whose state (shared + those items) fits the cap; an item that
 * cannot fit even alone is refused, never split or truncated. Hard rule: no item's state is
 * ever sent twice — each item lands in exactly one call, or is refused.
 */
export interface SiteCaps {
  stateTokens: number;
  itemsPerCall: number;
}

export const DEFAULT_CAPS: Record<JudgeSite, SiteCaps> = {
  handoff: { stateTokens: 6000, itemsPerCall: 40 },
  experts: { stateTokens: 8000, itemsPerCall: 1 },
  delegates: { stateTokens: 3000, itemsPerCall: 1 },
  approvals: { stateTokens: 2500, itemsPerCall: 1 },
  stuck: { stateTokens: 8000, itemsPerCall: 12 },
};

/** The judge's question in the System One wire format. */
export function wireQuestion(ask: Ask): Question {
  switch (ask.kind) {
    case "yes-no":
      return noul(ask.instructions);
    case "label":
      return choice(ask.instructions, ask.labels);
    case "score":
      return score(ask.instructions, ask.levels);
  }
}

/** Wire names are positional (`q0`, `q1`…) so verdict ids never leak odd characters onto the wire. */
export function wireQuestions(units: readonly JudgeUnit[]): Questions {
  const out: Questions = {};
  units.forEach((u, i) => (out[`q${i}`] = wireQuestion(u.ask)));
  return out;
}

/** Items keyed by their key, under `items` when there is a shared part. */
export function packState(shared: State | undefined, items: readonly { key: string; state: State }[]): State {
  const byKey: Record<string, unknown> = {};
  for (const item of items) byKey[item.key] = item.state;
  return shared === undefined ? byKey : { shared, items: byKey };
}

export interface Packed {
  calls: JudgeCall[];
  /** units of items that cannot fit even alone */
  refused: JudgeUnit[];
}

function fits(state: State, units: readonly JudgeUnit[], caps: SiteCaps, limits: Limits): boolean {
  return estimateTokens(state) <= caps.stateTokens && requestFits(state, wireQuestions(units), limits);
}

export function pack(question: PerItemQuestion, units: readonly JudgeUnit[], caps: SiteCaps, limits: Limits): Packed {
  const unitsOf = new Map<string, JudgeUnit[]>();
  for (const u of units) if (u.item !== undefined) unitsOf.set(u.item, [...(unitsOf.get(u.item) ?? []), u]);
  const calls: JudgeCall[] = [];
  const refused: JudgeUnit[] = [];
  let current: { key: string; state: State }[] = [];
  const unitsFor = (items: readonly { key: string }[]): JudgeUnit[] => items.flatMap((i) => unitsOf.get(i.key) ?? []);
  const flush = (): void => {
    if (current.length === 0) return;
    calls.push({ site: question.site, state: packState(question.shared, current), stateTokens: caps.stateTokens, units: unitsFor(current) });
    current = [];
  };
  const seen = new Set<string>();
  for (const item of question.items) {
    if (seen.has(item.key)) continue; // a repeated key would send a state twice
    seen.add(item.key);
    if (!fits(packState(question.shared, [item]), unitsFor([item]), caps, limits)) {
      refused.push(...unitsFor([item]));
      continue;
    }
    const candidate = [...current, item];
    if (current.length >= caps.itemsPerCall || !fits(packState(question.shared, candidate), unitsFor(candidate), caps, limits)) {
      flush();
      current = [item];
    } else current = candidate;
  }
  flush();
  return { calls, refused };
}

/** A single-state question as one call; throws `DecisionLimitError` over the cap. */
export function fit(question: SingleQuestion, units: readonly JudgeUnit[], caps: SiteCaps, limits: Limits): JudgeCall {
  const tokens = estimateTokens(question.state);
  if (tokens > caps.stateTokens) throw new DecisionLimitError(`state ~${tokens} tok exceeds the ${question.site} cap of ${caps.stateTokens}`);
  if (!requestFits(question.state, wireQuestions(units), limits)) throw new DecisionLimitError(`request exceeds the model limits`);
  return { site: question.site, state: question.state, stateTokens: caps.stateTokens, units: [...units] };
}
