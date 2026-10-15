import { useState } from "react";
import type { Handoff, Turn } from "@tide/contracts";
import { Pill } from "../ui/Pill.tsx";
import styles from "./HandoffCard.module.css";

/** `covers 6 turns, 2 omitted` */
export function handoffCoverage(handoff: Handoff): string {
  const n = handoff.coveredTurnIds.length;
  const m = handoff.omittedTurnIds.length;
  return `covers ${n} turn${n === 1 ? "" : "s"}, ${m} omitted`;
}

/** The verbatim history a harness was given when the thread changed harness or forked. Collapsed by default. */
export function HandoffCard({ handoff, delivery }: { handoff: Handoff; delivery: Turn["handoffDelivery"] }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={styles.card}>
      <button type="button" className={styles.head} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{open ? "▾" : "▸"}</span>
        <span className={styles.title}>Handoff</span>
        <Pill>{handoff.strategy}</Pill>
        <span className={styles.meta}>{handoffCoverage(handoff)}</span>
        {delivery === undefined ? null : <Pill tone="accent">{delivery}</Pill>}
        {handoff.fromProvider === undefined ? null : (
          <span className={styles.meta}>
            {handoff.fromProvider} → {handoff.toProvider}
          </span>
        )}
      </button>
      {open ? <pre className={styles.text}>{handoff.text}</pre> : null}
    </li>
  );
}
