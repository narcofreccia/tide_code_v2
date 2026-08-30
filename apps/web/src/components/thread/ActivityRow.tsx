import { useState } from "react";
import type { Activity } from "@tide/contracts";
import { formatDuration, formatPayload, toolGlyph, toolTarget } from "../../lib/activity.ts";
import styles from "./ActivityRow.module.css";

const MARK: Record<string, string> = { ok: "✓", error: "✕", running: "…" };

/** One 24px stream line: `▸ Read src/foo.ts` / `❯ Bash pnpm test ✓ 2.1s`. */
export function ActivityRow({ activity }: { activity: Activity }) {
  const [open, setOpen] = useState(false);

  if (activity.kind === "info" || activity.kind === "error") {
    return (
      <li className={styles.item}>
        <div className={`${styles.row} ${activity.kind === "error" ? styles.error : styles.info}`}>
          <span className={styles.glyph}>{activity.kind === "error" ? "✕" : "·"}</span>
          <span className={styles.target}>{activity.text}</span>
        </div>
      </li>
    );
  }
  if (activity.kind !== "tool") return null;

  const target = toolTarget(activity.input);
  const tone = styles[activity.status] ?? "";
  const output = activity.output ?? "";
  const input = formatPayload(activity.input);

  return (
    <li className={styles.item}>
      <button
        type="button"
        className={styles.row}
        aria-expanded={open}
        aria-label={`${activity.toolName}${target ? ` ${target}` : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`${styles.glyph} ${tone}`}>{toolGlyph(activity.toolName)}</span>
        <span className={styles.name}>{activity.toolName}</span>
        <span className={styles.target}>{target}</span>
        <span className={`${styles.mark} ${tone}`}>{MARK[activity.status] ?? ""}</span>
        {activity.durationMs === undefined ? null : (
          <span className={styles.duration}>{formatDuration(activity.durationMs)}</span>
        )}
      </button>
      {open ? (
        <div className={styles.details}>
          {input ? (
            <>
              <span className={styles.label}>input</span>
              <pre className={styles.pre}>{input}</pre>
            </>
          ) : null}
          {output ? (
            <>
              <span className={styles.label}>output</span>
              <pre className={styles.pre}>{output}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
