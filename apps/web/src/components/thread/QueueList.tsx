import { useState } from "react";
import { selectQueuedTurns, selectTurnPrompt } from "@tide/client";
import { dequeueTurn } from "../../lib/threadActions.ts";
import { editQueuedTurn, promoteTurn, reorderQueue } from "../../lib/turnActions.ts";
import { useModel } from "../../state/model.ts";
import { Button } from "../ui/Button.tsx";
import styles from "./QueueList.module.css";

function QueueRow({
  index,
  count,
  turnId,
  text,
  canPromote,
  onMove,
  onDrop,
}: {
  index: number;
  count: number;
  turnId: string;
  text: string;
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
          <button
            type="button"
            className={styles.icon}
            aria-label="Move queued turn up"
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className={styles.icon}
            aria-label="Move queued turn down"
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            ↓
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
            ✎
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
            ×
          </button>
        </>
      )}
    </li>
  );
}

/** The thread's queued follow-ups: edit, reorder, promote to a steer, or drop. */
export function QueueList({
  threadId,
  running,
  canSteer,
}: {
  threadId: string;
  running: boolean;
  canSteer: boolean;
}) {
  const model = useModel((s) => s.model);
  const turns = selectQueuedTurns(model, threadId);
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
        <QueueRow
          key={turn.id}
          index={index}
          count={turns.length}
          turnId={turn.id}
          text={selectTurnPrompt(model, threadId, turn.id) ?? ""}
          canPromote={running && canSteer}
          onMove={(delta) => move(index, index + delta)}
          onDrop={(from) => move(from, index)}
        />
      ))}
    </ol>
  );
}
