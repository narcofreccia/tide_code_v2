import { useEffect, useRef, useState } from "react";
import type { Thread } from "@tide/contracts";
import { updateThread } from "../../lib/threadActions.ts";
import styles from "./ThreadTitle.module.css";

/**
 * The thread's title in the header. Plain text until you double-click it or press
 * the pencil; then an input: Enter / blur commits, Escape reverts.
 */
export function ThreadTitle({ thread }: { thread: Thread }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(thread.title);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(thread.title), [thread.id, thread.title]);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const finish = (save: boolean): void => {
    setEditing(false);
    const next = draft.trim();
    if (!save || !next || next === thread.title) return setDraft(thread.title);
    updateThread(thread.id, { title: next });
  };

  if (editing) {
    return (
      <span className={styles.wrap}>
        <input
          ref={input}
          className={styles.input}
          aria-label="Thread title"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") finish(true);
            else if (e.key === "Escape") {
              // the composer would otherwise read this Escape as "stop the turn"
              e.preventDefault();
              e.stopPropagation();
              e.nativeEvent.stopImmediatePropagation();
              finish(false);
            }
          }}
        />
      </span>
    );
  }

  return (
    <span className={styles.wrap} title="Rename" onDoubleClick={() => setEditing(true)}>
      <span className={styles.text}>{thread.title}</span>
      <button type="button" className={styles.pencil} aria-label="Rename thread" onClick={() => setEditing(true)}>
        ✎
      </button>
    </span>
  );
}
