import type { FollowUp, FollowUpMode } from "../../lib/followUp.ts";
import styles from "./FollowUpToggle.module.css";

const OPTIONS: { value: FollowUpMode; label: string; title: string }[] = [
  { value: "steer", label: "Steer", title: "Deliver follow-ups into the running turn" },
  { value: "queue", label: "Queue", title: "Run follow-ups after the current turn" },
];

/** Steer | Queue: what a message sent during a running turn does by default. */
export function FollowUpToggle({ followUp, provider }: { followUp: FollowUp; provider: string }) {
  const reason = followUp.canSteer ? undefined : `${provider} cannot steer; follow-ups queue`;
  return (
    <div className={styles.toggle} role="group" aria-label="Follow-up mode" {...(reason ? { title: reason } : {})}>
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={styles.option}
          aria-pressed={followUp.mode === option.value}
          disabled={!followUp.canSteer}
          title={reason ?? option.title}
          onClick={() => followUp.setMode(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
