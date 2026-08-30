import { useEffect, useState } from "react";
import type { Thread } from "@tide/contracts";
import { updateThread } from "../../lib/threadActions.ts";
import styles from "./ThreadTitle.module.css";

/** Inline rename: commit on blur/Enter, revert on Escape. */
export function ThreadTitle({ thread }: { thread: Thread }) {
  const [draft, setDraft] = useState(thread.title);
  useEffect(() => setDraft(thread.title), [thread.id, thread.title]);

  const commit = (): void => {
    const next = draft.trim();
    if (!next || next === thread.title) return setDraft(thread.title);
    updateThread(thread.id, { title: next });
  };

  return (
    <input
      className={styles.title}
      aria-label="Thread title"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setDraft(thread.title);
      }}
    />
  );
}
