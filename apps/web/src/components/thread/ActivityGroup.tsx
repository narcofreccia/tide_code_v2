import { useState } from "react";
import type { ActivityOf } from "@tide/contracts";
import { formatDuration, summarizeGroup } from "../../lib/activity.ts";
import { ActivityRow } from "./ActivityRow.tsx";
import { Chevron } from "./Chevron.tsx";
import styles from "./ActivityRow.module.css";

const MAX_NAMES = 3;

/**
 * "Bash, Read, Edit…": the distinct tools of a mixed group, most recent first, at
 * most three. Empty for a same-tool run, whose summary ("read 4 files") says it all.
 */
export function groupToolNames(activities: ActivityOf<"tool">[]): string {
  const names: string[] = [];
  for (let i = activities.length - 1; i >= 0; i--) {
    const name = activities[i]!.toolName;
    if (!names.includes(name)) names.push(name);
  }
  if (names.length < 2) return "";
  return names.length > MAX_NAMES ? `${names.slice(0, MAX_NAMES).join(", ")}…` : names.join(", ");
}

/** Summed duration of the calls that reported one; `undefined` when none did. */
function groupDuration(activities: ActivityOf<"tool">[]): number | undefined {
  let total: number | undefined;
  for (const a of activities) if (a.durationMs !== undefined) total = (total ?? 0) + a.durationMs;
  return total;
}

/** Consecutive settled tool calls collapsed to one quiet line ("5 tool calls  Bash, Read, Edit…"). */
export function ActivityGroup({ activities }: { activities: ActivityOf<"tool">[] }) {
  const [open, setOpen] = useState(false);
  const names = groupToolNames(activities);
  const duration = groupDuration(activities);
  return (
    <li className={styles.item}>
      <button
        type="button"
        className={`${styles.row} ${styles.groupRow}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.glyph}>
          <Chevron open={open} />
        </span>
        <span className={styles.groupLabel}>{summarizeGroup(activities)}</span>
        {names === "" ? null : <span className={styles.groupNames}>{names}</span>}
        {duration === undefined ? null : <span className={styles.duration}>{formatDuration(duration)}</span>}
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
