import { useState } from "react";
import { selectInbox, type InboxItem } from "@tide/client";
import { describeAttention } from "../../lib/activity.ts";
import { relativeTime } from "../../lib/relativeTime.ts";
import { PROVIDER_LABELS } from "../../lib/vocab.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { ApprovalCard } from "../thread/ApprovalCard.tsx";
import { PlanCard } from "../thread/PlanCard.tsx";
import { UserInputCard } from "../thread/UserInputCard.tsx";
import { Button } from "../ui/Button.tsx";
import { Pill } from "../ui/Pill.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { useTicker } from "./useTicker.ts";
import styles from "./MissionControl.module.css";

/** At or above this the decisions model's "stuck" probability earns a chip. */
export const STUCK_THRESHOLD = 0.6;

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
 * Everything waiting on the user — every pending card, each rendering its real
 * card inline: an approval is allowed or denied from here, a question answered,
 * a plan sent to a new thread. Ordered by triage urgency when the decisions
 * model scored it, then by how long it has waited. `↑`/`↓` move between items
 * while focus is inside the inbox; the focused approval takes `y`/`n`.
 */
export function InboxColumn({ projectId }: { projectId?: string }) {
  const model = useModel((s) => s.model);
  const selectThread = useUi((s) => s.selectThread);
  const items = selectInbox(model, projectId);
  const [focused, setFocused] = useState(0);
  const count = items.length;
  const index = count === 0 ? 0 : Math.min(focused, count - 1);
  // "waiting 4m" ages in place
  const now = useTicker(count > 0 ? 30_000 : 0);

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (count < 2 || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
    if (event.key === "ArrowDown") setFocused(Math.min(count - 1, index + 1));
    else if (event.key === "ArrowUp") setFocused(Math.max(0, index - 1));
    else return;
    event.preventDefault();
  };

  return (
    <section className={styles.section} aria-label="Inbox" tabIndex={-1} onKeyDown={onKeyDown}>
      <h2 className={styles.label}>Inbox{count > 0 ? ` · ${count}` : ""}</h2>
      {count === 0 ? (
        <p className={styles.empty}>Nothing needs you right now.</p>
      ) : (
        items.map((item, i) => {
          const triage = item.thread.triage;
          const stuck = triage !== undefined && triage.stuck >= STUCK_THRESHOLD ? triage.stuck : undefined;
          return (
            <article
              key={item.key}
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
                {stuck === undefined ? null : (
                  <span
                    className={styles.stuck}
                    title="The decisions model thinks this thread may be stuck. It never acts on it."
                  >
                    possibly stuck · {Math.round(stuck * 100)}%
                  </span>
                )}
                <span className={styles.waiting} title={new Date(item.since).toLocaleString()}>
                  waiting {relativeTime(item.since, now)}
                </span>
                <Button variant="link" className={styles.jump} onClick={() => selectThread(item.thread.id)}>
                  jump →
                </Button>
              </div>
              <ul className={styles.cards}>
                <ItemCard item={item} active={i === index} />
              </ul>
            </article>
          );
        })
      )}
    </section>
  );
}
