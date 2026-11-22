import { useState } from "react";
import type { UsageSummary } from "@tide/contracts";
import { formatTokens, formatUsd } from "../../lib/glassBox.ts";
import { barStep, daySpend } from "./usageMath.ts";
import styles from "./Usage.module.css";

type ChartMetric = "tokens" | "spend";

function dayTitle(day: UsageSummary["days"][number]): string {
  const parts = [`${day.day}: ${formatTokens(day.tokens)} tokens`];
  if (day.costUsd !== undefined) parts.push(`${formatUsd(day.costUsd)} reported`);
  if (day.estimatedUsd !== undefined) parts.push(`≈${formatUsd(day.estimatedUsd)} estimated`);
  return parts.join(" · ");
}

/** Tokens or spend per day as CSS columns; the height is a class from a 5 % step scale. */
export function DayBars({ days }: { days: UsageSummary["days"] }) {
  const [metric, setMetric] = useState<ChartMetric>("tokens");
  const [activeDay, setActiveDay] = useState<UsageSummary["days"][number] | undefined>(undefined);
  if (days.length === 0) return <p className={styles.note}>No usage in this window.</p>;

  const hasSpend = days.some((d) => daySpend(d) > 0);
  const mode: ChartMetric = metric === "spend" && hasSpend ? "spend" : "tokens";
  const valueOf = (day: UsageSummary["days"][number]): number => (mode === "spend" ? daySpend(day) : day.tokens);
  const max = Math.max(...days.map(valueOf));
  const peakLabel = mode === "spend" ? `peak ≈${formatUsd(max)}` : `peak ${formatTokens(max)}`;
  // an 11px "MM-DD" needs ~32px; past two weeks label about ten days, always the last
  const every = days.length > 14 ? Math.ceil(days.length / 10) : 1;

  return (
    <div className={styles.chartCard}>
      <div className={styles.chartHead}>
        <div className={styles.chartTitleGroup}>
          <span className={styles.chartTitle}>Daily activity</span>
          <span className={styles.chartReadout}>{activeDay ? dayTitle(activeDay) : peakLabel}</span>
        </div>
        {hasSpend ? (
          <div className={styles.metricPicker} role="radiogroup" aria-label="Chart metric">
            <button
              type="button"
              role="radio"
              aria-checked={mode === "tokens"}
              className={`${styles.chip} ${mode === "tokens" ? styles.chipOn : ""}`}
              onClick={() => setMetric("tokens")}
            >
              Tokens
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === "spend"}
              className={`${styles.chip} ${mode === "spend" ? styles.chipOn : ""}`}
              onClick={() => setMetric("spend")}
            >
              Spend
            </button>
          </div>
        ) : null}
      </div>
      <div
        className={styles.bars}
        role="list"
        aria-label={mode === "spend" ? "Spend per day" : "Tokens per day"}
        onMouseLeave={() => setActiveDay(undefined)}
      >
        {days.map((day, i) => {
          const step = barStep(valueOf(day), max);
          const isActive = activeDay?.day === day.day;
          return (
            <div
              key={day.day}
              className={`${styles.barCol} ${isActive ? styles.barColActive : ""}`}
              role="listitem"
              title={dayTitle(day)}
              aria-label={dayTitle(day)}
              onMouseEnter={() => setActiveDay(day)}
            >
              <span className={`${styles.bar} ${mode === "spend" ? styles.barSpend : ""} ${styles[`h${step}`] ?? ""}`} />
              <span className={styles.barLabel}>{i % every === 0 || i === days.length - 1 ? day.day.slice(5) : ""}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
