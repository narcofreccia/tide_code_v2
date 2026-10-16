import { selectInbox } from "@tide/client";
import type { Thread } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { ThreadGlyph } from "../ui/StatusGlyph.tsx";
import styles from "./NeedsYouGroup.module.css";

/** One row per thread (a thread with three waiting cards is still one row), oldest wait first. */
function waitingThreads(items: ReturnType<typeof selectInbox>): Thread[] {
  const seen = new Set<string>();
  const out: Thread[] = [];
  for (const item of items) {
    if (seen.has(item.thread.id)) continue;
    seen.add(item.thread.id);
    out.push(item.thread);
  }
  return out;
}

/**
 * Cross-project "Needs you · n" at the top of the rail: everything waiting on an
 * approval, a question or a plan decision, whatever project it belongs to.
 * Hidden when empty — a quiet rail has no group at all.
 */
export function NeedsYouGroup() {
  const model = useModel((s) => s.model);
  const selectedThreadId = useUi((s) => (s.view === "thread" ? s.selectedThreadId : null));
  const selectThread = useUi((s) => s.selectThread);
  const threads = waitingThreads(selectInbox(model));
  if (threads.length === 0) return null;

  return (
    <section className={styles.group} aria-label="Needs you">
      <h3 className={styles.heading}>
        Needs you <span className={styles.count}>· {threads.length}</span>
      </h3>
      <ul className={styles.list}>
        {threads.map((thread) => (
          <li key={thread.id}>
            <button
              type="button"
              className={`${styles.row} ${selectedThreadId === thread.id ? styles.active : ""}`}
              onClick={() => selectThread(thread.id)}
            >
              <ThreadGlyph thread={thread} />
              <span className={styles.title}>{thread.title}</span>
              <span className={styles.project}>{model.projects[thread.projectId]?.title ?? ""}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
