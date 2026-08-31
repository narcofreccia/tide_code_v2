import { useEffect, useState } from "react";
import { selectInbox, type InboxItem } from "@tide/client";
import { describeAttention } from "../../lib/activity.ts";
import { PROVIDER_LABELS } from "../../lib/vocab.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { ApprovalCard } from "../thread/ApprovalCard.tsx";
import { PlanCard } from "../thread/PlanCard.tsx";
import { UserInputCard } from "../thread/UserInputCard.tsx";
import { Pill } from "../ui/Pill.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import styles from "./MissionControl.module.css";

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** The harness's own card for this item, so it can be answered without leaving. */
function ItemCard({ item, active }: { item: InboxItem; active: boolean }) {
  const activity = item.activity;
  if (item.attention === "plan") {
    return item.plan ? <PlanCard plan={item.plan} provider={item.thread.provider} /> : null;
  }
  if (activity?.kind === "approval") return <ApprovalCard activity={activity} active={active} />;
  if (activity?.kind === "user-input") return <UserInputCard activity={activity} />;
  return <li className={styles.empty}>{describeAttention(item)}</li>;
}

/**
 * Everything waiting on the user, each rendering its real card inline: an
 * approval is allowed or denied from here, a question answered, a plan sent to a
 * new thread. `↑`/`↓` move between items; the focused approval takes `y`/`n`.
 */
export function InboxColumn({ projectId }: { projectId?: string }) {
  const model = useModel((s) => s.model);
  const selectThread = useUi((s) => s.selectThread);
  const items = selectInbox(model, projectId);
  const [focused, setFocused] = useState(0);
  const count = items.length;
  const index = count === 0 ? 0 : Math.min(focused, count - 1);

  useEffect(() => {
    if (count < 2) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      if (event.key === "ArrowDown") setFocused((i) => Math.min(count - 1, Math.min(i, count - 1) + 1));
      else if (event.key === "ArrowUp") setFocused((i) => Math.max(0, Math.min(i, count - 1) - 1));
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count]);

  return (
    <section className={styles.section} aria-label="Inbox">
      <h2 className={styles.label}>Inbox</h2>
      {count === 0 ? (
        <p className={styles.empty}>Nothing needs you right now.</p>
      ) : (
        items.map((item, i) => (
          <article
            key={item.thread.id}
            className={styles.item}
            data-focused={i === index ? "true" : "false"}
            aria-label={`Inbox: ${item.thread.title}`}
            onMouseDown={() => setFocused(i)}
          >
            <div className={styles.itemHead}>
              <StatusGlyph status={item.thread.status} attention={item.attention} />
              <span className={styles.itemTitle}>{item.thread.title}</span>
              <span className={styles.meta}>{model.projects[item.thread.projectId]?.title ?? "—"}</span>
              <Pill>{PROVIDER_LABELS[item.thread.provider]}</Pill>
              <button type="button" className={styles.jump} onClick={() => selectThread(item.thread.id)}>
                jump →
              </button>
            </div>
            <ul className={styles.cards}>
              <ItemCard item={item} active={i === index} />
            </ul>
          </article>
        ))
      )}
    </section>
  );
}
