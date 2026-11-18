import type { QuotaView } from "@tide/client";
import { quotaShortText, quotaTitle } from "../../lib/quota.ts";
import { Pill } from "../ui/Pill.tsx";
import styles from "./Quota.module.css";

/**
 * A scope's quota as a small bar: green under the warning line, amber from it, red at the cap,
 * grey while the server has not measured a new cap. The tooltip carries the figures.
 */
export function QuotaMeter({ view, wide = false, label }: { view: QuotaView; wide?: boolean; label?: string }) {
  const used = view.usedPct ?? 0;
  return (
    <span className={styles.meterWrap} title={quotaTitle(view)}>
      <meter
        className={`${styles.meter} ${wide ? styles.wide : ""}`}
        data-tone={view.status}
        min={0}
        max={100}
        value={Math.min(100, Math.max(0, used))}
        aria-label={`Quota of ${view.title}`}
      />
      <span>{label ?? quotaShortText(view)}</span>
    </span>
  );
}

/** The thread header's chip while a quota holds the thread: `Held by quota`, the figures in the tooltip. */
export function QuotaChip({ view }: { view: QuotaView }) {
  const whose = view.scope === "project" ? `Project quota of ${view.title}` : `Quota of ${view.title}`;
  return (
    <Pill tone="error" size="sm" className={styles.chip} title={`${whose}\n${quotaTitle(view)}`}>
      Held by quota
    </Pill>
  );
}
