import { useEffect, useRef, useState } from "react";
import { useIsDirty } from "../../state/docs.ts";
import { useModel } from "../../state/model.ts";
import { closeSideChat } from "../thread/useSideChat.ts";
import { fileGlyph } from "../../lib/fileIcons.ts";
import {
  closeTab,
  moveTab,
  setActiveTab,
  tabKey,
  togglePin,
  type WorkbenchTab,
} from "../../state/workbench.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import styles from "./Workbench.module.css";
import strip from "./TabStrip.module.css";
import { useOverflowEdge, useWheelScrollX } from "./useWheelScrollX.ts";

function label(tab: WorkbenchTab): string {
  if (tab.kind === "changes") return "Changes";
  if (tab.kind === "search") return "Search";
  if (tab.kind === "experts") return "Board";
  if (tab.kind === "preview") return "Preview";
  if (tab.kind === "side") return "Side chat";
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
        {tab.pinned ? <Icon name="pin" size={12} label="pinned" className={styles.pin ?? ""} /> : null}
        {dirty ? <span className={styles.dot} aria-label="unsaved changes" /> : null}
      </button>
      <Button variant="quiet" className={styles.close} aria-label={`Close ${label(tab)}`} onClick={() => closeTab(threadId, tab)}>
        <Icon name="close" size={12} />
      </Button>
    </span>
  );
}

/** R16: a side chat, labelled with its thread's title; closing an unused one deletes it. */
function SideTabButton({ threadId, tab, active }: { threadId: string; tab: Extract<WorkbenchTab, { kind: "side" }>; active: boolean }) {
  const title = useModel((s) => s.model.threads[tab.threadId]?.title) ?? label(tab);
  return (
    <span className={styles.tabWrap}>
      <button
        type="button"
        role="tab"
        aria-selected={active}
        title={`Side chat: ${title}`}
        className={`${styles.tab} ${active ? styles.active : ""}`}
        onClick={() => setActiveTab(threadId, tab)}
      >
        <span className={styles.glyph} aria-hidden="true">
          ⋯
        </span>
        {title}
      </button>
      <Button variant="quiet" className={styles.close} aria-label={`Close ${title}`} onClick={() => closeSideChat(threadId, tab.threadId)}>
        <Icon name="close" size={12} />
      </Button>
    </span>
  );
}

/** Changes first, then Search and the open files; drag to reorder, the close button or middle-click to close. */
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
  const scroller = useRef<HTMLDivElement>(null);
  useWheelScrollX(scroller);
  const edge = useOverflowEdge(scroller, tabs.length);

  useEffect(() => {
    const el = scroller.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    el?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [activeKey]);

  return (
    <div className={strip.strip}>
      <div
        ref={scroller}
        className={`scrollX ${strip.scroll}`}
        role="tablist"
        aria-label="Workbench tabs"
        data-overflow={edge}
      >
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
          ) : tab.kind === "side" ? (
            <SideTabButton key={tabKey(tab)} threadId={threadId} tab={tab} active={tabKey(tab) === activeKey} />
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
                <Button variant="quiet" className={styles.close} aria-label={`Close ${label(tab)}`} onClick={() => closeTab(threadId, tab)}>
                  <Icon name="close" size={12} />
                </Button>
              )}
            </span>
          ),
        )}
      </div>
      <div className={strip.actions}>
        {running ? (
          <span className={styles.running} title="The agent is writing in this worktree">
            agent running
          </span>
        ) : null}
        {children}
      </div>
    </div>
  );
}
