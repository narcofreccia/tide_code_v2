import type { RunSummary } from "@tide/client";
import { useUi } from "../../../state/ui.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { Pill, type PillTone } from "../../ui/Pill.tsx";
import { Popover } from "../../ui/Popover.tsx";
import styles from "./Run.module.css";

/** failed → error, starting → running, everything up → ok; nothing running is neutral. */
export function summaryTone(summary: RunSummary): PillTone {
  switch (summary.worst) {
    case "failed":
      return "error";
    case "starting":
      return "running";
    case undefined:
    case "exited":
      return "muted";
    default:
      return summary.up === summary.total ? "ok" : "muted";
  }
}

/** "Run · 3/5 up" with Start stack / Stop all / Refresh and a `more` menu. */
export function StackHeader({
  summary,
  selectedCount,
  starting,
  collapsed,
  onToggleCollapsed,
  onStart,
  onStopAll,
  onRefresh,
  onRescan,
}: {
  summary: RunSummary;
  /** shown as the total before anything runs */
  selectedCount: number;
  starting: boolean;
  /** strip mode only: the header folds the rows away */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onStart: () => void;
  onStopAll: () => void;
  onRefresh: () => void;
  onRescan: () => void;
}) {
  const total = summary.total > 0 ? summary.total : selectedCount;
  const title =
    onToggleCollapsed === undefined ? (
      <h3 className={styles.title}>Run</h3>
    ) : (
      <button type="button" className={styles.toggle} aria-expanded={!collapsed} onClick={onToggleCollapsed}>
        <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={12} />
        <span className={styles.title}>Run</span>
      </button>
    );
  return (
    <div className={styles.header}>
      {title}
      <Pill size="sm" tone={summaryTone(summary)} title="Services up in this stack">
        {summary.up}/{total} up
      </Pill>
      <span className={styles.spacer} />
      {summary.up > 0 || summary.worst === "starting" ? (
        <Button variant="quiet" onClick={onStopAll}>
          <Icon name="stop" size={14} />
          Stop all
        </Button>
      ) : null}
      <Button variant="primary" disabled={starting || selectedCount === 0} onClick={onStart}>
        <Icon name="play" size={14} />
        Start stack
      </Button>
      <Button variant="quiet" aria-label="Refresh run profiles" title="Refresh" onClick={onRefresh}>
        <Icon name="refresh" size={14} />
      </Button>
      <Popover label={<Icon name="more" label="More run actions" />} title="More run actions" variant="quiet" align="end">
        {(close) => (
          <div className={styles.menu}>
            <Button
              variant="quiet"
              onClick={() => {
                close();
                onRescan();
              }}
            >
              Rescan profiles
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                close();
                useUi.getState().openSettings("projects");
              }}
            >
              Open run settings
            </Button>
          </div>
        )}
      </Popover>
    </div>
  );
}
