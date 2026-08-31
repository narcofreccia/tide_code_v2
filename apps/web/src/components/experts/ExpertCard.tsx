import type { ExpertState, Thread } from "@tide/contracts";
import { openExpertThread } from "../../lib/expertsActions.ts";
import { Pill } from "../ui/Pill.tsx";
import styles from "./Board.module.css";

const GLYPH: Record<ExpertState["status"], string> = {
  pending: "◌",
  working: "●",
  idle: "○",
  error: "✕",
};

/** ◌ pending · ● working · ○ idle · ✕ error — the expert's own run state. */
export function ExpertStatusGlyph({ status }: { status: ExpertState["status"] }) {
  return (
    <span className={`${styles.glyph} ${styles[status] ?? ""}`} title={status} aria-label={status} role="img">
      {GLYPH[status]}
    </span>
  );
}

/** One seat at the panel. Clicking it opens that expert's thread beside the board. */
export function ExpertCard({
  expert,
  thread,
  selected,
}: {
  expert: ExpertState;
  thread: Thread | undefined;
  selected: boolean;
}) {
  const threadId = thread?.id ?? expert.threadId;
  return (
    <button
      type="button"
      className={`${styles.expert} ${selected ? styles.selected : ""}`}
      disabled={threadId === undefined}
      title={threadId === undefined ? "Thread not spawned yet" : `Open ${expert.name}'s thread`}
      aria-label={`Expert ${expert.name}`}
      onClick={() => {
        if (threadId !== undefined) openExpertThread(threadId);
      }}
    >
      <span className={styles.expertHead}>
        <ExpertStatusGlyph status={expert.status} />
        <span className={styles.expertName}>{expert.name}</span>
      </span>
      <span className={styles.expertRole}>{expert.role}</span>
      <span className={styles.expertMeta}>
        <Pill>{expert.provider}</Pill>
        {expert.model ? <span className={styles.model}>{expert.model}</span> : null}
      </span>
    </button>
  );
}
