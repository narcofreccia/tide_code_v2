import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message, Turn } from "@tide/contracts";
import { formatDuration } from "../../lib/activity.ts";
import { formatBytes } from "../../lib/images.ts";
import { formatTokens } from "../../lib/glassBox.ts";
import { useUi } from "../../state/ui.ts";
import { openFileTab } from "../../state/workbench.ts";
import { cite } from "../../lib/cite.ts";
import { MarkdownPre } from "./VisualBlocks.tsx";
import { Button } from "../ui/Button.tsx";
import { Popover } from "../ui/Popover.tsx";
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

const SETTLED: Turn["status"][] = ["completed", "error", "interrupted"];

/** ⋯ on a settled turn's user message: fork or roll back from this point. */
function TurnMenu({ turn }: { turn: Turn }) {
  const open = (kind: "fork" | "rollback"): void =>
    useUi.getState().setThreadDialog({ kind, threadId: turn.threadId, turnId: turn.id });
  return (
    <span className={styles.turnMenu}>
      <Popover label="⋯" title="Turn actions" variant="quiet" align="end">
        {(close) => (
          <div className={styles.menuItems}>
            <Button variant="quiet" onClick={() => (close(), open("fork"))}>
              Fork from here…
            </Button>
            <Button variant="quiet" onClick={() => (close(), open("rollback"))}>
              Rollback to before this turn…
            </Button>
          </div>
        )}
      </Popover>
    </span>
  );
}

const MARKDOWN_COMPONENTS = { pre: MarkdownPre };

type MessageAttachment = NonNullable<Message["attachments"]>[number];

/** Images are metadata pills; R11 files live in the worktree and open in the workbench. */
function Attachments({ message }: { message: Message }) {
  const list = message.attachments ?? [];
  if (list.length === 0) return null;
  const open = (a: MessageAttachment): void => {
    if (a.path !== undefined) openFileTab(message.threadId, a.path);
  };
  return (
    <span className={styles.attachments}>
      {list.map((attachment, i) =>
        attachment.path === undefined ? (
          <Pill key={`${attachment.mediaType}-${i}`}>
            🖼 {attachment.mediaType} · {formatBytes(attachment.bytes)}
          </Pill>
        ) : (
          <button
            key={attachment.path}
            type="button"
            className={styles.fileChip}
            title={`Open ${attachment.path}`}
            onClick={() => open(attachment)}
          >
            📄 {attachment.name ?? attachment.path.slice(attachment.path.lastIndexOf("/") + 1)} · {formatBytes(attachment.bytes)}
          </button>
        ),
      )}
    </span>
  );
}

export interface MessageItemProps {
  message: Message;
  /** the turn this message belongs to, when the model knows it */
  turn?: Turn;
  /** last assistant message of a settled turn — the one that carries the footer */
  showMeta?: boolean;
  /** the turn waited behind an earlier one; its prompt keeps the tag after it ran */
  wasQueued?: boolean;
  /** R11: where a citation of this message says it came from, e.g. `turn 3 of "Fix auth"` */
  citeLabel?: string;
}

/** User turns stay plain text; assistant prose renders as markdown. */
export function MessageItem({ message, turn, showMeta, wasQueued, citeLabel }: MessageItemProps) {
  const isUser = message.role === "user";
  const queued = isUser && message.steer !== true && (turn?.status === "queued" || wasQueued === true);
  const streaming = message.streaming === true;
  const rolledBack = turn?.rolledBack === true;
  const menuTurn =
    isUser && turn && SETTLED.includes(turn.status) && message.steer !== true && !rolledBack ? turn : undefined;
  return (
    <li
      className={`${isUser ? styles.user : styles.assistant} ${rolledBack ? styles.rolledBack : ""}`}
      {...(rolledBack ? { "data-rolled-back": "true" } : {})}
      {...(!isUser ? { "data-cite-label": citeLabel ?? "" } : {})}
    >
      <div className={styles.body} data-role={message.role}>
        {queued ? (
          <span className={styles.queued} title="Sent while an earlier turn was running">
            <Pill tone="idle">queued</Pill>
          </span>
        ) : null}
        {message.steer === true ? (
          <span className={styles.tag}>
            <Pill tone="accent">steer</Pill>
          </span>
        ) : null}
        {rolledBack && isUser ? (
          <span className={styles.tag}>
            <Pill tone="interrupted">rolled back</Pill>
          </span>
        ) : null}
        {message.reasoning ? (
          <Reasoning text={message.reasoning} auto={streaming && message.text === ""} />
        ) : null}
        {isUser ? (
          message.text
        ) : (
          <div className={styles.markdown}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
              {message.text}
            </ReactMarkdown>
          </div>
        )}
        <Attachments message={message} />
        {streaming ? <span className={styles.caret} aria-label="streaming" /> : null}
      </div>
      {menuTurn ? <TurnMenu turn={menuTurn} /> : null}
      {!isUser && !streaming && message.text.trim() !== "" ? (
        <span className={styles.actions}>
          <Button variant="quiet" title="Quote this reply in the composer" onClick={() => cite(message.text, citeLabel)}>
            Quote
          </Button>
        </span>
      ) : null}
      {showMeta === true && turn ? <TurnMeta turn={turn} /> : null}
    </li>
  );
}
