import { memo, useState } from "react";
import type { Handoff, Turn } from "@tide/contracts";
import { Icon } from "../ui/Icon.tsx";
import { Pill } from "../ui/Pill.tsx";
import { Chevron } from "./Chevron.tsx";
import styles from "./HandoffCard.module.css";
import { plural } from "../../lib/format.ts";

/** `covers 6 turns, 2 omitted`, or once the judge refined it `12 items, 9 kept by judge (jev 0.87), 3 dropped` */
export function handoffCoverage(handoff: Handoff): string {
  const j = handoff.judge;
  if (j !== undefined) return `${j.kept + j.dropped} items, ${j.kept} kept by judge (${j.source} ${j.confidence.toFixed(2)}), ${j.dropped} dropped`;
  const n = handoff.coveredTurnIds.length;
  const m = handoff.omittedTurnIds.length;
  return `covers ${plural(n, "turn")}, ${m} omitted`;
}

/** The verbatim history a harness was given when the thread changed harness or forked. Collapsed by default. */
export const HandoffCard = memo(function HandoffCard({ handoff, delivery }: { handoff: Handoff; delivery: Turn["handoffDelivery"] }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={styles.card}>
      <button type="button" className={styles.head} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Chevron open={open} />
        <span className={styles.title}>Handoff</span>
        <Pill>{handoff.strategy}</Pill>
        <span className={styles.meta}>{handoffCoverage(handoff)}</span>
        {delivery === undefined ? null : <Pill tone="accent">{delivery}</Pill>}
        {handoff.fromProvider === undefined ? null : (
          <span className={styles.meta} aria-label={`${handoff.fromProvider} to ${handoff.toProvider}`}>
            {handoff.fromProvider}
            <Icon name="arrowRight" size={12} />
            {handoff.toProvider}
          </span>
        )}
      </button>
      {open ? <pre className={styles.text}>{handoff.text}</pre> : null}
    </li>
  );
});
