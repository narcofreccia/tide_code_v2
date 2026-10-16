import { useState } from "react";
import type { Activity } from "@tide/contracts";
import type { TimelineItem } from "@tide/client";
import { ActivityRow } from "./ActivityRow.tsx";
import styles from "./ActivityRow.module.css";

type Note = Extract<Activity, { kind: "info" | "error" }>;

/** Raw harness frames Tide does not model (`claude: system/task_notification`). Declines stay visible. */
export function isPassThrough(activity: Activity): activity is Note {
  return activity.kind === "info" && activity.payload !== undefined && !/declined/.test(activity.text);
}

export interface Collapsed {
  entries: TimelineItem[];
  /** id of the first pass-through row of a turn -> every pass-through row of that turn */
  groups: Map<string, Note[]>;
}

/** Keeps the first pass-through row of each turn as the anchor for one disclosure; drops the rest. */
export function collapsePassThrough(entries: TimelineItem[]): Collapsed {
  const anchorByTurn = new Map<string, string>();
  const groups = new Map<string, Note[]>();
  const out: TimelineItem[] = [];
  for (const entry of entries) {
    if (entry.kind === "activity" && isPassThrough(entry.activity)) {
      const turn = entry.activity.turnId;
      const anchor = anchorByTurn.get(turn);
      if (anchor === undefined) {
        anchorByTurn.set(turn, entry.activity.id);
        groups.set(entry.activity.id, [entry.activity]);
        out.push(entry);
      } else {
        groups.get(anchor)?.push(entry.activity);
      }
      continue;
    }
    out.push(entry);
  }
  return { entries: out, groups };
}

/** One muted "n harness events" line per turn; open it to see each raw row. */
export function HarnessEvents({ activities }: { activities: Note[] }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={styles.item}>
      <button type="button" className={styles.row} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className={styles.glyph}>{open ? "▾" : "▸"}</span>
        <span className={`${styles.summary} ${styles.info}`}>
          {activities.length} harness {activities.length === 1 ? "event" : "events"}
        </span>
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
