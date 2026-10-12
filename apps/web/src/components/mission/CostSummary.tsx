import type { ProviderCost } from "@tide/client";
import { formatUsd } from "../../lib/glassBox.ts";
import { PROVIDER_LABELS } from "../../lib/vocab.ts";
import styles from "./CostSummary.module.css";

/**
 * `$1.75 today · $24.10 lifetime` then one muted chip per harness that cost
 * anything (`Claude Code $20.10`, today's share on hover). Turn-level figures
 * as the harnesses reported them — nothing estimated.
 */
export function CostSummary({
  todayUsd,
  lifetimeUsd,
  byProvider,
}: {
  todayUsd: number;
  lifetimeUsd: number;
  byProvider: ProviderCost[];
}) {
  return (
    <span className={styles.cost}>
      <span className={styles.figure} title="Turns that settled today (local time)">
        {formatUsd(todayUsd)} today
      </span>
      <span className={styles.figure} title="Every turn this scope has ever run, archived threads included">
        {formatUsd(lifetimeUsd)} lifetime
      </span>
      {byProvider.length > 0 ? (
        <span className={styles.providers} aria-label="Cost by provider">
          {byProvider.map((row) => (
            <span
              key={row.provider}
              className={styles.provider}
              title={`${PROVIDER_LABELS[row.provider]}: ${formatUsd(row.todayUsd)} today · ${formatUsd(row.lifetimeUsd)} lifetime`}
            >
              {PROVIDER_LABELS[row.provider]} {formatUsd(row.lifetimeUsd)}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
