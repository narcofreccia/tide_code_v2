import { useState } from "react";
import type { ActivityOf } from "@tide/contracts";
import { summarizeGroup } from "../../lib/activity.ts";
import { ActivityRow } from "./ActivityRow.tsx";
import styles from "./ActivityRow.module.css";

/** Consecutive settled tool calls collapsed to one line ("read 4 files"). */
export function ActivityGroup({ activities }: { activities: ActivityOf<"tool">[] }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={styles.item}>
      <button type="button" className={styles.row} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className={styles.glyph}>{open ? "▾" : "▸"}</span>
        <span className={styles.summary}>{summarizeGroup(activities)}</span>
      </button>
      {open ? (
        <ul className={`${styles.childRows} ${styles.nested}`}>
          {activities.map((a) => (
            <ActivityRow key={a.id} activity={a} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
