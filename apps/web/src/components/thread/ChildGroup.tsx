import { memo, useEffect, useMemo, useRef, useState } from "react";
import { groupActivities } from "@tide/client";
import type { Activity, ActivityOf } from "@tide/contracts";
import { useUi } from "../../state/ui.ts";
import { useRevealNonce } from "../../state/childReveal.ts";
import { ActivityGroup } from "./ActivityGroup.tsx";
import { ActivityRow } from "./ActivityRow.tsx";
import { Chevron } from "./Chevron.tsx";
import { LiveLabel } from "./LiveLabel.tsx";
import { Markdown } from "./Markdown.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Pill } from "../ui/Pill.tsx";
import { useTurnSettled } from "./activities/turnSettled.ts";
import styles from "./ActivityRow.module.css";
import own from "./ChildGroup.module.css";


/** A sub-agent named after a long command: the shimmer label cannot ellipsize (its sweep copy must match the drawn text), so cap it. */
const LABEL_MAX = 72;
function capLabel(name: string): string {
  return name.length > LABEL_MAX ? `${name.slice(0, LABEL_MAX - 1)}…` : name;
}

/** past this a report opens clipped to 320px with a "Show all" */
const LONG_REPORT = 1200;

/**
 * What the row can honestly say. `open`: the turn settled while the harness never
 * reported the sub-agent finished — it may still be running in the background, or its
 * closing event was lost. Neither a spinner nor a check.
 */
type ChildState = "running" | "done" | "error" | "open";

function childState(status: ActivityOf<"child">["status"], turnSettled: boolean): ChildState {
  return status === "running" && turnSettled ? "open" : status;
}

const OPEN_NOTE = "running in the background — the thread continues when it reports";

function StateMark({ state }: { state: ChildState }) {
  if (state === "running") return <LiveLabel text="…" />;
  if (state === "done") return <Icon name="check" size={12} label="done" />;
  if (state === "error") return <Icon name="close" size={12} label="failed" />;
  return <Icon name="clock" size={12} label={OPEN_NOTE} />;
}

/** The sub-agent's final report as markdown, clipped until asked for in full. */
function ChildReport({ report }: { report: string }) {
  const long = report.length > LONG_REPORT || report.split("\n").length > 16;
  const [all, setAll] = useState(false);
  return (
    <div className={own.reportWrap}>
      <div className={`${own.report} ${long && !all ? own.clipped : ""}`} data-testid="child-report">
        <Markdown text={report} />
      </div>
      {long ? (
        <Button variant="link" className={own.showAll} onClick={() => setAll((v) => !v)}>
          {all ? "Show less" : "Show all"}
        </Button>
      ) : null}
    </div>
  );
}

/** A harness sub-agent: name, type, state and one-line summary; opens to its report and its own rows. */
export const ChildGroup = memo(function ChildGroup({ child, activities }: { child: ActivityOf<"child">; activities: Activity[] }) {
  const state = childState(child.status, useTurnSettled(child.turnId));
  const [open, setOpen] = useState(state === "running");
  const selectThread = useUi((s) => s.selectThread);
  const nodes = useMemo(() => groupActivities(activities.map((activity) => ({ kind: "activity" as const, activity }))), [activities]);
  const tone = state === "error" ? styles.error : state === "running" ? styles.running : state === "done" ? styles.ok : "";
  const report = child.report?.trim() ? child.report : undefined;
  const summary = child.summary ?? (state === "open" ? OPEN_NOTE : undefined);
  const expandable = report !== undefined || nodes.length > 0;
  // "show in the transcript" from the background strip or a "reported" notice: open, scroll, focus
  const reveal = useRevealNonce(child.threadId, child.childKey);
  const itemRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (reveal === 0) return;
    setOpen(true);
    const el = itemRef.current;
    el?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    el?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [reveal]);

  return (
    <li className={styles.item} ref={itemRef} data-child-key={child.childKey}>
      <div className={styles.row}>
        <button
          type="button"
          className={styles.rowBare}
          aria-expanded={expandable ? open : undefined}
          onClick={() => setOpen((v) => !v)}
        >
          <span className={`${styles.glyph} ${tone}`}>◇</span>
          {state === "running" ? (
            <LiveLabel className={styles.liveName} text={`subagent: ${capLabel(child.name)}`} />
          ) : (
            <span className={`${styles.name} ${styles.nameLong}`}>subagent: {child.name}</span>
          )}
          {child.description ? (
            <Pill size="sm" className={own.type}>
              {child.description}
            </Pill>
          ) : null}
          <span className={own.summary} title={summary}>
            {summary}
          </span>
          <span className={`${styles.mark} ${tone}`}>
            <StateMark state={state} />
          </span>
          {expandable ? (
            <span className={styles.glyph}>
              <Chevron open={open} />
            </span>
          ) : null}
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
      {open && expandable ? (
        <div className={`${styles.nested} ${styles.child}`}>
          {report === undefined ? null : <ChildReport report={report} />}
          {nodes.length > 0 ? (
            <ul className={styles.childRows}>
              {nodes.map((node) =>
                node.kind === "group" ? (
                  <ActivityGroup key={node.id} activities={node.activities} />
                ) : node.kind === "activity" ? (
                  <ActivityRow key={node.activity.id} activity={node.activity} ownerRunning={child.status === "running"} />
                ) : null,
              )}
            </ul>
          ) : null}
        </div>
      ) : null}
    </li>
  );
});
