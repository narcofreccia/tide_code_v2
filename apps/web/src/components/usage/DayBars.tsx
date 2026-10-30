import type { UsageSummary } from "@tide/contracts";
import { formatTokens, formatUsd } from "../../lib/glassBox.ts";
import { barStep } from "./usageMath.ts";
import styles from "./Usage.module.css";

function dayTitle(day: UsageSummary["days"][number]): string {
  const parts = [`${day.day}: ${formatTokens(day.tokens)} tokens`];
  if (day.costUsd !== undefined) parts.push(`${formatUsd(day.costUsd)} reported`);
  if (day.estimatedUsd !== undefined) parts.push(`≈${formatUsd(day.estimatedUsd)} estimated`);
  return parts.join(" · ");
}

/** Tokens per day as CSS columns; the height is a class from a 5 % step scale. */
export function DayBars({ days }: { days: UsageSummary["days"] }) {
  if (days.length === 0) return <p className={styles.note}>No usage in this window.</p>;
  const max = Math.max(...days.map((d) => d.tokens));
  return (
    <div className={styles.bars} role="list" aria-label="Tokens per day">
      {days.map((day) => (
        <div key={day.day} className={styles.barCol} role="listitem" title={dayTitle(day)} aria-label={dayTitle(day)}>
          <span className={`${styles.bar} ${styles[`h${barStep(day.tokens, max)}`] ?? ""}`} />
          <span className={styles.barLabel}>{day.day.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}
