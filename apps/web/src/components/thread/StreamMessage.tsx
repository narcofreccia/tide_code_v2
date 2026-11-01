import { memo } from "react";
import type { Activity, ProviderKind } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { HandoffCard } from "./HandoffCard.tsx";
import { MessageItem } from "./MessageItem.tsx";
import { NoticeRow } from "./NoticeRow.tsx";
import { TurnConclusion } from "./TurnConclusion.tsx";

export interface StreamMessageProps {
  messageId: string;
  provider: ProviderKind;
  /** last assistant message of a settled turn: footer and conclusion line */
  showMeta: boolean;
  wasQueued: boolean;
  /** 1-based position of the message's turn in the thread, for the citation label */
  turnNumber: number | undefined;
  /** the turn's activities, for the conclusion line (only with `showMeta`) */
  conclusion: Activity[] | undefined;
}

/**
 * One message row of the stream, reading its own slice of the model: a delta on this
 * message re-renders this row only, and nothing here re-renders for another message.
 */
export const StreamMessage = memo(function StreamMessage({ messageId, provider, showMeta, wasQueued, turnNumber, conclusion }: StreamMessageProps) {
  const message = useModel((s) => s.model.messages[messageId]);
  const turn = useModel((s) => {
    const m = s.model.messages[messageId];
    return m === undefined ? undefined : s.model.turns[m.turnId];
  });
  const handoffId = message?.role === "user" && message.steer !== true ? turn?.handoffId : undefined;
  const handoff = useModel((s) => (handoffId === undefined ? undefined : s.model.handoffs[handoffId]));
  const isAssistant = message?.role === "assistant";
  const title = useModel((s) => (isAssistant && message ? s.model.threads[message.threadId]?.title : undefined));
  if (message === undefined) return null;
  if (message.notification !== undefined) return <NoticeRow message={message} provider={provider} />;
  const label = isAssistant ? citeLabel(turnNumber, title) : undefined;
  return (
    <>
      {handoff ? <HandoffCard handoff={handoff} delivery={turn?.handoffDelivery} /> : null}
      <MessageItem message={message} turn={turn} showMeta={showMeta} wasQueued={wasQueued} citeLabel={label} />
      {showMeta ? <TurnConclusion activities={conclusion ?? NONE} threadId={message.threadId} turnId={message.turnId} /> : null}
    </>
  );
});

const NONE: Activity[] = [];

/** R11: where a citation of a reply says it came from, e.g. `turn 3 of "Fix auth"`. */
function citeLabel(turnNumber: number | undefined, title: string | undefined): string {
  const name = title ?? "this thread";
  return turnNumber === undefined ? `"${name}"` : `turn ${turnNumber} of "${name}"`;
}
