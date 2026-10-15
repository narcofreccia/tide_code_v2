import type { EventOf, HandoffStrategy, ProviderKind, ReadModel, Thread, Turn } from "@tide/contracts";
import { handoffBudget, selectHandoff } from "../handoff/select.ts";
import type { DecideContext } from "./types.ts";

export interface RecordHandoffInput {
  /** the thread whose next turn carries the handoff */
  threadId: string;
  /** the thread the history is read from (itself on a provider switch, the source on a fork) */
  source: Thread;
  fromProvider?: ProviderKind | undefined;
  toProvider: ProviderKind;
  strategy: HandoffStrategy;
  turns: Turn[];
}

/** Builds the `handoff.recorded` event: a budgeted verbatim selection of `turns` from `source`. */
export function recordHandoff(model: ReadModel, input: RecordHandoffInput, ctx: DecideContext): EventOf<"handoff.recorded"> {
  const selection = selectHandoff(model, {
    threadId: input.source.id,
    toProvider: input.toProvider,
    strategy: input.strategy,
    turns: input.turns,
    budgetBytes: handoffBudget({ cap: ctx.handoffCap, window: input.source.contextUsage?.window }),
    sourceTitle: input.source.title,
  });
  return {
    type: "handoff.recorded",
    handoff: {
      id: ctx.newId(),
      threadId: input.threadId,
      sourceThreadId: input.source.id,
      ...(input.fromProvider !== undefined ? { fromProvider: input.fromProvider } : {}),
      toProvider: input.toProvider,
      strategy: input.strategy,
      coveredTurnIds: selection.coveredTurnIds,
      omittedTurnIds: selection.omittedTurnIds,
      text: selection.text,
      createdAt: ctx.now,
    },
  };
}
