import { selectInbox } from "@tide/client";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { describeAttention } from "../../lib/activity.ts";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import styles from "./Inbox.module.css";

/** Approvals / questions / plans-ready across every thread — the reason Tide exists. */
export function Inbox() {
  const model = useModel((s) => s.model);
  const selectThread = useUi((s) => s.selectThread);
  const items = selectInbox(model);

  return (
    <section className={styles.inbox} aria-label="Inbox">
      <h2 className={styles.heading}>Inbox</h2>
      {items.length === 0 ? (
        <p className={styles.empty}>Nothing needs you right now.</p>
      ) : (
        <ul className={styles.list}>
          {items.map((item) => (
            <li key={item.thread.id}>
              <button type="button" className={styles.row} onClick={() => selectThread(item.thread.id)}>
                <StatusGlyph status={item.thread.status} attention={item.attention} />
                <span className={styles.title}>{item.thread.title}</span>
                <span className={styles.need}>{describeAttention(item)}</span>
                <span className={styles.jump}>jump →</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
