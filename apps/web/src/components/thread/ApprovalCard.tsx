import { memo, useEffect } from "react";
import type { ActivityOf, ApprovalDecision } from "@tide/contracts";
import { toolTarget } from "../../lib/activity.ts";
import { diffStats, parseUnifiedDiff } from "../../lib/diff.ts";
import { useServerSettings } from "../../state/serverSettings.ts";
import { respondApproval } from "../../lib/threadActions.ts";
import { Button } from "../ui/Button.tsx";
import { Pill } from "../ui/Pill.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { RequestFrom, type RequestOrigin } from "./RequestFrom.tsx";
import styles from "./Card.module.css";

const DECISION_LABEL: Record<ApprovalDecision, string> = {
  accept: "Allowed",
  acceptForSession: "Allowed for session",
  acceptAlways: "Always allowed",
  decline: "Denied",
  cancel: "Cancelled",
};

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

function DiffPreview({ diff }: { diff: string }) {
  const lines = parseUnifiedDiff(diff);
  const { added, removed } = diffStats(lines);
  return (
    <>
      <span className={styles.stats}>
        +{added} −{removed}
      </span>
      <pre className={styles.diff} aria-label="diff">
        {lines.map((line, i) => (
          <span key={i} className={`${styles.diffLine} ${styles[line.kind] ?? ""}`}>
            {line.text}
          </span>
        ))}
      </pre>
    </>
  );
}

/**
 * A harness permission prompt, mapped 1:1. `y` / `n` answer the card that is
 * currently the thread's live prompt. `from` marks a child thread's card answered
 * from its parent (R16); those pass `active={false}`: no hotkeys, no hints.
 */
export const ApprovalCard = memo(function ApprovalCard({
  activity,
  active,
  from,
}: {
  activity: ActivityOf<"approval">;
  active: boolean;
  from?: RequestOrigin;
}) {
  const pending = activity.status === "pending";
  const low = useServerSettings((s) => s.settings.decisions.grayZone.low);
  const judged = activity.judge?.label !== undefined && activity.judge.confidence >= low ? activity.judge : undefined;
  const target = toolTarget(activity.input);
  const respond = (decision: ApprovalDecision): void =>
    respondApproval(activity.threadId, activity.requestId, decision);

  useEffect(() => {
    if (!pending || !active) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (e.key === "y" || e.key === "Y") respond("accept");
      else if (e.key === "n" || e.key === "N") respond("decline");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!pending) {
    const label = activity.decision ? DECISION_LABEL[activity.decision] : "Closed";
    return (
      <li className={styles.resolved}>
        <span>
          {label} {activity.toolName}
        </span>
        <span className={styles.target}>{target}</span>
      </li>
    );
  }

  return (
    <li>
      <section className={`${styles.card} ${styles.attention}`} aria-label={`Approval: ${activity.toolName}`}>
        {from ? <RequestFrom what="Approval needed" from={from} /> : null}
        <div className={styles.head}>
          <span className={styles.title}>{activity.title ?? activity.toolName}</span>
          {judged ? (
            <Pill tone={judged.label === "consequential" ? "needs" : "muted"}>
              <span title={`${judged.source} ${judged.confidence.toFixed(2)}`}>{judged.label}</span>
            </Pill>
          ) : null}
          <span className={styles.target}>{target}</span>
        </div>
        {activity.description ? <p className={styles.description}>{activity.description}</p> : null}
        {activity.reason ? (
          <p className={styles.reason} title="Why the harness asked instead of deciding itself">
            Asked because: {activity.reason}
          </p>
        ) : null}
        {activity.diff ? <DiffPreview diff={activity.diff} /> : null}
        <div className={styles.actions}>
          <Button variant="primary" onClick={() => respond("accept")}>
            Allow
          </Button>
          <Button onClick={() => respond("acceptForSession")}>Allow for session</Button>
          <Button onClick={() => respond("decline")}>Deny</Button>
          {active ? (
            <span className={styles.hint}>
              <Kbd>y</Kbd> / <Kbd>n</Kbd>
            </span>
          ) : null}
        </div>
      </section>
    </li>
  );
});
