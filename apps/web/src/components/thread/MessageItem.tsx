import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message, Turn } from "@tide/contracts";
import { formatDuration } from "../../lib/activity.ts";
import { formatBytes } from "../../lib/images.ts";
import { formatTokens } from "../../lib/glassBox.ts";
import { dequeueTurn } from "../../lib/threadActions.ts";
import { Pill } from "../ui/Pill.tsx";
import styles from "./MessageItem.module.css";

/**
 * Extended thinking, folded away. It opens itself while the model is still
 * thinking and nothing else is on screen, then gets out of the way once the
 * answer starts — unless the reader has said otherwise.
 */
function Reasoning({ text, auto }: { text: string; auto: boolean }) {
  const [override, setOverride] = useState<boolean | undefined>(undefined);
  const open = override ?? auto;
  return (
    <div className={styles.reasoning}>
      <button
        type="button"
        className={styles.reasoningToggle}
        aria-expanded={open}
        onClick={() => setOverride(!open)}
      >
        {open ? "▾" : "▸"} Thinking
      </button>
      {open ? <pre className={styles.reasoningBody}>{text}</pre> : null}
    </div>
  );
}

/** `in 1,200 · out 340 · cache read 8,000 · cache write 512` */
function usageTitle(usage: NonNullable<Turn["usage"]>): string {
  const parts = [`in ${usage.inputTokens.toLocaleString("en-US")}`, `out ${usage.outputTokens.toLocaleString("en-US")}`];
  if (usage.cacheReadTokens !== undefined) parts.push(`cache read ${usage.cacheReadTokens.toLocaleString("en-US")}`);
  if (usage.cacheWriteTokens !== undefined) parts.push(`cache write ${usage.cacheWriteTokens.toLocaleString("en-US")}`);
  return parts.join(" · ");
}

/** What the turn cost, once it settled: duration, tokens, money, or why it stopped. */
function TurnMeta({ turn }: { turn: Turn }) {
  const started = turn.startedAt ?? turn.requestedAt;
  const duration = turn.settledAt === undefined ? undefined : Math.max(0, turn.settledAt - started);
  const usage = turn.usage;
  const cache = (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0);
  const failed = turn.status === "error" || turn.status === "interrupted";
  return (
    <div className={styles.meta} data-tone={failed ? "error" : "muted"}>
      {duration === undefined ? null : <span>{formatDuration(duration)}</span>}
      {usage === undefined ? null : (
        <span title={usageTitle(usage)}>
          ↑{formatTokens(usage.inputTokens)} ↓{formatTokens(usage.outputTokens)}
          {cache > 0 ? ` ⟳${formatTokens(cache)}` : ""}
        </span>
      )}
      {usage?.costUsd === undefined ? null : <span>${usage.costUsd.toFixed(4)}</span>}
      {failed ? <span className={styles.metaError}>{turn.error ?? turn.status}</span> : null}
    </div>
  );
}

export interface MessageItemProps {
  message: Message;
  /** the turn this message belongs to, when the model knows it */
  turn?: Turn;
  /** last assistant message of a settled turn — the one that carries the footer */
  showMeta?: boolean;
}

/** User turns stay plain text; assistant prose renders as markdown. */
export function MessageItem({ message, turn, showMeta }: MessageItemProps) {
  const isUser = message.role === "user";
  const queued = isUser && turn?.status === "queued" ? turn : undefined;
  const streaming = message.streaming === true;
  return (
    <li className={isUser ? styles.user : styles.assistant}>
      <div className={styles.body} data-role={message.role}>
        {queued ? (
          <span className={styles.queued}>
            <Pill tone="accent">queued</Pill>
            <button
              type="button"
              className={styles.drop}
              aria-label="Remove queued turn"
              title="Remove this queued turn"
              onClick={() => dequeueTurn(queued.id)}
            >
              ×
            </button>
          </span>
        ) : null}
        {message.reasoning ? (
          <Reasoning text={message.reasoning} auto={streaming && message.text === ""} />
        ) : null}
        {isUser ? (
          message.text
        ) : (
          <div className={styles.markdown}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
          </div>
        )}
        {message.attachments === undefined || message.attachments.length === 0 ? null : (
          <span className={styles.attachments}>
            {message.attachments.map((attachment, i) => (
              <Pill key={`${attachment.mediaType}-${i}`}>
                🖼 {attachment.mediaType} · {formatBytes(attachment.bytes)}
              </Pill>
            ))}
          </span>
        )}
        {streaming ? <span className={styles.caret} aria-label="streaming" /> : null}
      </div>
      {showMeta === true && turn ? <TurnMeta turn={turn} /> : null}
    </li>
  );
}
