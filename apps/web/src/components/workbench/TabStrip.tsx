import { useState } from "react";
import { useIsDirty } from "../../state/docs.ts";
import { fileGlyph } from "../../lib/fileIcons.ts";
import {
  closeTab,
  moveTab,
  setActiveTab,
  tabKey,
  togglePin,
  type WorkbenchTab,
} from "../../state/workbench.ts";
import styles from "./Workbench.module.css";

function label(tab: WorkbenchTab): string {
  if (tab.kind === "changes") return "Changes";
  if (tab.kind === "search") return "Search";
  if (tab.kind === "experts") return "Board";
  return tab.path.slice(tab.path.lastIndexOf("/") + 1);
}

function FileTabButton({
  threadId,
  tab,
  active,
  index,
  onDragStart,
  onDrop,
}: {
  threadId: string;
  tab: Extract<WorkbenchTab, { kind: "file" }>;
  active: boolean;
  index: number;
  onDragStart: (index: number) => void;
  onDrop: (index: number) => void;
}) {
  const dirty = useIsDirty(threadId, tab.path);
  return (
    <span
      className={styles.tabWrap}
      draggable
      onDragStart={() => onDragStart(index)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={() => onDrop(index)}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        closeTab(threadId, tab);
      }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        title={tab.path}
        className={`${styles.tab} ${active ? styles.active : ""}`}
        onClick={() => setActiveTab(threadId, tab)}
        onDoubleClick={() => togglePin(threadId, tab.path)}
      >
        <span className={styles.glyph}>{fileGlyph(tab.path)}</span>
        {label(tab)}
        {tab.pinned ? <span className={styles.pin} aria-label="pinned">📌</span> : null}
        {dirty ? <span className={styles.dot} aria-label="unsaved changes" /> : null}
      </button>
      <button
        type="button"
        className={styles.close}
        aria-label={`Close ${label(tab)}`}
        onClick={() => closeTab(threadId, tab)}
      >
        ×
      </button>
    </span>
  );
}

/** Changes first, then Search and the open files; drag to reorder, × or middle-click to close. */
export function TabStrip({
  threadId,
  tabs,
  active,
  running,
  children,
}: {
  threadId: string;
  tabs: WorkbenchTab[];
  active: WorkbenchTab;
  running: boolean;
  children?: React.ReactNode;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const activeKey = tabKey(active);

  return (
    <div className={styles.tabs} role="tablist" aria-label="Workbench tabs">
      {tabs.map((tab, index) =>
        tab.kind === "file" ? (
          <FileTabButton
            key={tabKey(tab)}
            threadId={threadId}
            tab={tab}
            index={index}
            active={tabKey(tab) === activeKey}
            onDragStart={setDragging}
            onDrop={(to) => {
              if (dragging !== null) moveTab(threadId, dragging, to);
              setDragging(null);
            }}
          />
        ) : (
          <span key={tabKey(tab)} className={styles.tabWrap}>
            <button
              type="button"
              role="tab"
              aria-selected={tabKey(tab) === activeKey}
              className={`${styles.tab} ${tabKey(tab) === activeKey ? styles.active : ""}`}
              onClick={() => setActiveTab(threadId, tab)}
            >
              {label(tab)}
            </button>
            {tab.kind === "changes" ? null : (
              <button
                type="button"
                className={styles.close}
                aria-label={`Close ${label(tab)}`}
                onClick={() => closeTab(threadId, tab)}
              >
                ×
              </button>
            )}
          </span>
        ),
      )}
      {running ? (
        <span className={styles.running} title="The agent is writing in this worktree">
          agent running
        </span>
      ) : null}
      <span className={styles.spacer} />
      {children}
    </div>
  );
}
