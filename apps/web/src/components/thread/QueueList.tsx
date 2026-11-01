import { memo, useState } from "react";
import { selectQueuedTurns, selectSteerFallbackReason, selectTurnPrompt } from "@tide/client";
import { dequeueTurn } from "../../lib/threadActions.ts";
import { editQueuedTurn, promoteTurn, reorderQueue } from "../../lib/turnActions.ts";
import { useModel } from "../../state/model.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import styles from "./QueueList.module.css";
import { STEER_FALLBACK_NOTE } from "./steerFallback.ts";

function QueueRow({
  index,
  count,
  turnId,
  text,
  fallbackReason,
  canPromote,
  onMove,
  onDrop,
}: {
  index: number;
  count: number;
  turnId: string;
  text: string;
  /** the harness refused this message as a steer: why (the queue row says so) */
  fallbackReason?: string | undefined;
  canPromote: boolean;
  onMove: (delta: -1 | 1) => void;
  onDrop: (from: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [saving, setSaving] = useState(false);

  const save = (): void => {
    const next = draft.trim();
    if (next === "" || saving) return;
    if (next === text) {
      setEditing(false);
      return;
    }
    setSaving(true);
    void editQueuedTurn(turnId, next).then((ok) => {
      setSaving(false);
      if (ok) setEditing(false);
    });
  };

  return (
    <li
      className={styles.row}
      draggable={!editing}
      onDragStart={(e) => e.dataTransfer?.setData("text/plain", String(index))}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer?.getData("text/plain"));
        if (Number.isInteger(from) && from !== index) onDrop(from);
      }}
    >
      <span className={styles.position}>{index + 1}</span>
      {editing ? (
        <>
          <textarea
            className={styles.edit}
            aria-label="Edit queued message"
            rows={2}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setEditing(false);
              }
            }}
          />
          <Button variant="primary" disabled={saving || draft.trim() === ""} onClick={save}>
            Save
          </Button>
          <Button variant="quiet" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <>
          <span className={styles.text} title={text}>
            {text}
          </span>
          {fallbackReason !== undefined ? (
            <span className={styles.fallback} title={fallbackReason}>
              {STEER_FALLBACK_NOTE}
            </span>
          ) : null}
          <button
            type="button"
            className={styles.icon}
            aria-label="Move queued turn up"
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <Icon name="chevronDown" size={14} className={`${styles.up}`} />
          </button>
          <button
            type="button"
            className={styles.icon}
            aria-label="Move queued turn down"
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            <Icon name="chevronDown" size={14} />
          </button>
          <button
            type="button"
            className={styles.icon}
            aria-label="Edit queued turn"
            title="Edit this message"
            onClick={() => {
              setDraft(text);
              setEditing(true);
            }}
          >
            <Icon name="edit" size={14} />
          </button>
          {canPromote ? (
            <button
              type="button"
              className={styles.send}
              title="Deliver this into the running turn now"
              onClick={() => promoteTurn(turnId)}
            >
              Send now as steer
            </button>
          ) : null}
          <button
            type="button"
            className={`${styles.icon} ${styles.drop}`}
            aria-label="Remove queued turn"
            title="Remove this queued turn"
            onClick={() => dequeueTurn(turnId)}
          >
            <Icon name="close" size={14} />
          </button>
        </>
      )}
    </li>
  );
}

/** A row reading its own prompt through a string selector, so unrelated model updates skip it. */
function QueueEntry({ threadId, turnId, ...rest }: Omit<Parameters<typeof QueueRow>[0], "text" | "fallbackReason"> & { threadId: string }) {
  const text = useModel((s) => selectTurnPrompt(s.model, threadId, turnId) ?? "");
  const fallbackReason = useModel((s) => selectSteerFallbackReason(s.model, turnId));
  return <QueueRow {...rest} turnId={turnId} text={text} fallbackReason={fallbackReason} />;
}

/**
 * The thread's queued follow-ups: edit, reorder, promote to a steer, or drop.
 * Memoized and subscribed to the memoized queued-turns array only (stable while
 * `model.turns` is), so neither keystrokes nor streaming deltas re-render it.
 */
export const QueueList = memo(function QueueList({
  threadId,
  running,
  canSteer,
}: {
  threadId: string;
  running: boolean;
  canSteer: boolean;
}) {
  const turns = useModel((s) => selectQueuedTurns(s.model, threadId));
  if (turns.length === 0) return null;
  const ids = turns.map((t) => t.id);

  const move = (from: number, to: number): void => {
    const next = [...ids];
    const [item] = next.splice(from, 1);
    if (item === undefined) return;
    next.splice(to, 0, item);
    reorderQueue(threadId, next);
  };

  return (
    <ol className={styles.list} aria-label="Queued messages">
      {turns.map((turn, index) => (
        <QueueEntry
          key={turn.id}
          threadId={threadId}
          index={index}
          count={turns.length}
          turnId={turn.id}
          canPromote={running && canSteer}
          onMove={(delta) => move(index, index + delta)}
          onDrop={(from) => move(from, index)}
        />
      ))}
    </ol>
  );
});
