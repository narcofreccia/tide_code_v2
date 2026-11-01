import { memo, useState } from "react";
import type { Activity } from "@tide/contracts";
import type { TimelineItem } from "@tide/client";
import { ActivityRow } from "./ActivityRow.tsx";
import { Chevron } from "./Chevron.tsx";
import styles from "./ActivityRow.module.css";
import { plural } from "../../lib/format.ts";

type Note = Extract<Activity, { kind: "info" | "error" }>;

/** `claude: system/task_notification`, `codex: mcpServer/startupStatus/updated`, … */
const HARNESS_FRAME = /^(claude|codex|opencode|pi|acp): /;

/**
 * A usage-window warning row ("Rate limit allowed_warning on seven_day (96% used)", or an
 * exhausted overage window "Rate limit rejected on seven_day_overage_included …", which
 * does not stop work): the header's limit badge and the status bar already show it, so it
 * folds with the frames. Any other rejection stays in the stream.
 */
const RATE_WARNING = /^Rate limit (allowed(_warning)?\b|rejected on \w*overage)/;

/**
 * Raw harness frames Tide does not model: info rows carrying the native payload
 * or named after the harness frame they pass through, plus rate-limit warnings.
 * Declines stay visible.
 */
export function isPassThrough(activity: Activity): activity is Note {
  if (activity.kind !== "info" || /declined/.test(activity.text)) return false;
  return activity.payload !== undefined || HARNESS_FRAME.test(activity.text) || RATE_WARNING.test(activity.text);
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

/** `system/task_notification` -> "task notification", `session.updated` -> "session updated". */
function humanize(raw: string): string {
  const tail = raw.split("/").filter(Boolean).pop() ?? raw;
  return tail
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .trim()
    .toLowerCase();
}

/** A short name for one pass-through row: the native frame's subtype/type, else its text. */
export function eventName(note: Note): string {
  if (RATE_WARNING.test(note.text)) return "rate limit warning";
  const payload = typeof note.payload === "object" && note.payload !== null ? (note.payload as Record<string, unknown>) : undefined;
  const native = typeof payload?.["subtype"] === "string" ? payload["subtype"] : typeof payload?.["type"] === "string" ? payload["type"] : undefined;
  const text = note.text.replace(HARNESS_FRAME, "").replace(/\s*\(.*\)\s*$/, "");
  return humanize(native ?? text) || note.text;
}

/** Distinct event names, at most three, then "…". */
export function eventNames(notes: Note[]): string {
  const names = [...new Set(notes.map(eventName))];
  return names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")}, …`;
}

/** One muted "n harness events · names" line per turn; open it to see each raw row. */
export const HarnessEvents = memo(function HarnessEvents({ activities }: { activities: Note[] }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={styles.item}>
      <button type="button" className={`${styles.row} ${styles.groupRow}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className={styles.glyph}>
          <Chevron open={open} />
        </span>
        <span className={`${styles.groupLabel} ${styles.info}`}>{plural(activities.length, "harness event")}</span>
        {open ? null : <span className={styles.groupNames}>· {eventNames(activities)}</span>}
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
});
