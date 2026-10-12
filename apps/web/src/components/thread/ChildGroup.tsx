import { useState } from "react";
import { groupActivities } from "@tide/client";
import type { Activity, ActivityOf } from "@tide/contracts";
import { useUi } from "../../state/ui.ts";
import { ActivityGroup } from "./ActivityGroup.tsx";
import { ActivityRow } from "./ActivityRow.tsx";
import { Button } from "../ui/Button.tsx";
import styles from "./ActivityRow.module.css";

const MARK: Record<string, string> = { done: "✓", error: "✕", running: "…" };

/** A harness sub-agent: header line plus its own indented rows. */
export function ChildGroup({ child, activities }: { child: ActivityOf<"child">; activities: Activity[] }) {
  const [open, setOpen] = useState(child.status === "running");
  const selectThread = useUi((s) => s.selectThread);
  const nodes = groupActivities(activities.map((activity) => ({ kind: "activity" as const, activity })));
  const tone = child.status === "error" ? styles.error : child.status === "running" ? styles.running : styles.ok;

  return (
    <li className={styles.item}>
      <div className={styles.row}>
        <button
          type="button"
          className={styles.rowBare}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className={`${styles.glyph} ${tone}`}>◇</span>
          <span className={styles.name}>subagent: {child.name}</span>
          <span className={styles.target}>{child.description ?? child.summary}</span>
          <span className={`${styles.mark} ${tone}`}>{MARK[child.status] ?? ""}</span>
        </button>
        {child.childThreadId === undefined ? null : (
          <Button
            variant="link"
            className={styles.childLink}
            onClick={() => selectThread(child.childThreadId ?? null)}
          >
            open as thread
          </Button>
        )}
      </div>
      {open && nodes.length > 0 ? (
        <ul className={`${styles.childRows} ${styles.child} ${styles.nested}`}>
          {nodes.map((node) =>
            node.kind === "group" ? (
              <ActivityGroup key={node.id} activities={node.activities} />
            ) : node.kind === "activity" ? (
              <ActivityRow key={node.activity.id} activity={node.activity} />
            ) : null,
          )}
        </ul>
      ) : null}
    </li>
  );
}
