import type { DriverCaps, Handoff, ReadModel, Thread, Turn, TurnStatus } from "@tide/contracts";

const SETTLED: ReadonlySet<TurnStatus> = new Set<TurnStatus>(["completed", "interrupted", "error"]);

/** How a turn's handoff reaches the harness. `native` = a forked session that already holds the history. */
export type DeliveryPlan =
  | { handoff: Handoff; delivery: "inline" }
  | { handoff: Handoff; delivery: "native"; forkFrom: string; rollback: number };

/** turnId -> position of its first message in the thread's log. */
function turnOrder(model: ReadModel, threadId: string): Map<string, number> {
  const order = new Map<string, number>();
  (model.threadMessages[threadId] ?? []).forEach((id, i) => {
    const turnId = model.messages[id]?.turnId;
    if (turnId !== undefined && !order.has(turnId)) order.set(turnId, i);
  });
  return order;
}

/** The prompt a harness receives when the history has to be injected as text. */
export function inlinePrompt(handoff: Handoff, text: string): string {
  return `${handoff.text}\n\n---\n\nUser message:\n${text}`;
}

/**
 * Picks the delivery for a turn that carries a handoff. Native only for a fork's first turn on a
 * harness that can fork, when the source's own session on that harness saw every surviving turn
 * (any turn run elsewhere would be missing from it) and nothing is running on the source; turns
 * after the fork point are forgotten with `rollback(n)`, so that cap is needed when n > 0.
 * Everything else (provider switch, full or delta) is delivered inline.
 */
export function planHandoffDelivery(model: ReadModel, thread: Thread, turnId: string, caps: Partial<DriverCaps>): DeliveryPlan | undefined {
  const turn = model.turns[turnId];
  const handoff = turn?.handoffId === undefined ? undefined : model.handoffs[turn.handoffId];
  if (!handoff) return undefined;
  const inline: DeliveryPlan = { handoff, delivery: "inline" };
  const fork = thread.forkedFrom;
  if (fork === undefined || caps.fork !== true || handoff.sourceThreadId !== fork.threadId) return inline;
  const firstTurn = !Object.values(model.turns).some((t) => t.threadId === thread.id && t.id !== turnId && t.startedAt !== undefined);
  if (!firstTurn) return inline;
  const source = model.threads[fork.threadId];
  const forkFrom = source?.providerSessions?.[thread.provider]?.nativeSessionId;
  const forkTurn = model.turns[fork.turnId];
  if (!source || forkFrom === undefined || !forkTurn) return inline;
  const sourceTurns = Object.values(model.turns).filter((t) => t.threadId === source.id && !t.rolledBack);
  if (sourceTurns.some((t) => t.status === "requested" || t.status === "running")) return inline;
  const ran = sourceTurns.filter((t): t is Turn & { startedAt: number } => SETTLED.has(t.status) && t.startedAt !== undefined);
  if (ran.some((t) => t.provider !== thread.provider)) return inline;
  // order by the thread's message log: requestedAt ties within a millisecond
  const order = turnOrder(model, source.id);
  const forkAt = order.get(forkTurn.id) ?? -1;
  const rollback = ran.filter((t) => (order.get(t.id) ?? -1) > forkAt).length;
  if (rollback > 0 && caps.rollback !== true) return inline;
  return { handoff, delivery: "native", forkFrom, rollback };
}
