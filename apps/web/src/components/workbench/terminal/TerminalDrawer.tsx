import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  createPty,
  ensurePtys,
  killPty,
  setActivePty,
  setDrawerHeight,
  toggleDrawer,
  useTerminals,
  type PtyTab,
} from "../../../state/terminals.ts";
import { ContextMenu, type MenuItem, type MenuPosition } from "../../ui/Menu.tsx";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { Kbd } from "../../ui/Kbd.tsx";
import styles from "./TerminalDrawer.module.css";

/** xterm and its addons are their own chunk; the shell never pays for them. */
const TerminalView = lazy(async () => ({ default: (await import("./TerminalView.tsx")).TerminalView }));

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function useDragHeight(): (event: React.MouseEvent) => void {
  const start = useRef<{ y: number; height: number } | null>(null);
  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      if (!start.current) return;
      setDrawerHeight(start.current.height + (start.current.y - event.clientY));
    };
    const onUp = (): void => {
      start.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);
  return (event) => {
    start.current = { y: event.clientY, height: useTerminals.getState().height };
  };
}

/**
 * The shell's window title, one line: harnesses prefix it with a spinner/status glyph
 * ("✳ Loading screen redesign"), which the tab drops.
 */
export function tabTitle(given: string | undefined, index: number): string {
  const clean = given?.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return clean === undefined || clean === "" ? `sh ${index + 1}` : clean;
}

/** `` ⌘` `` drawer: one tab per pty of the thread; ptys outlive the drawer. */
export function TerminalDrawer({ threadId }: { threadId: string }) {
  const open = useTerminals((s) => s.drawerOpen);
  const height = useTerminals((s) => s.height);
  const tabs = useTerminals((s) => s.tabs[threadId]) ?? [];
  const active = useTerminals((s) => s.active[threadId]);
  const onDrag = useDragHeight();
  const drawer = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ at: MenuPosition; tab: PtyTab } | undefined>(undefined);

  const menuItems = (tab: PtyTab): MenuItem[] => [
    { label: "Close", onSelect: () => void killPty(threadId, tab.ptyId) },
    {
      label: "Close others",
      disabled: tabs.length < 2,
      onSelect: () => {
        setActivePty(threadId, tab.ptyId);
        for (const other of tabs) if (other.ptyId !== tab.ptyId) void killPty(threadId, other.ptyId);
      },
    },
  ];

  // the height is a CSS custom property, not an inline style object
  useLayoutEffect(() => {
    drawer.current?.style.setProperty("--drawer-h", `${height}px`);
  }, [open, height]);

  useEffect(() => {
    if (open) void ensurePtys(threadId);
  }, [open, threadId]);

  if (!open) return null;

  const current = tabs.find((t) => t.ptyId === active) ?? tabs[0];

  return (
    <div ref={drawer} className={styles.drawer} aria-label="Terminal" data-terminal-drawer="">
      <div
        className={styles.grip}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal"
        onMouseDown={onDrag}
      />
      <div className={styles.tabs} role="tablist">
        {tabs.map((tab, index) => {
          const name = tabTitle(tab.title, index);
          const selected = tab.ptyId === current?.ptyId;
          return (
            <span
              key={tab.ptyId}
              className={`${styles.tabWrap} ${selected ? styles.activeTab : ""}`}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ at: { x: e.clientX, y: e.clientY }, tab });
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                className={styles.tab}
                title={tab.alive ? (tab.title ?? name) : `${name} (exited)`}
                onClick={() => setActivePty(threadId, tab.ptyId)}
              >
                <span className={`${styles.dot} ${tab.alive ? "" : styles.dotExited}`} aria-hidden="true" />
                <span className={styles.tabName}>{name}</span>
              </button>
              <button
                type="button"
                className={styles.close}
                aria-label={`Close ${name}`}
                title="Close terminal"
                onClick={() => void killPty(threadId, tab.ptyId)}
              >
                <Icon name="close" size={12} />
              </button>
            </span>
          );
        })}
        <Button
          variant="quiet"
          aria-label="New terminal"
          title="New terminal"
          onClick={() => void createPty(threadId, DEFAULT_COLS, DEFAULT_ROWS)}
        >
          <Icon name="plus" size={14} />
        </Button>
        <Button variant="quiet" className={styles.hide} onClick={toggleDrawer} title="Hide terminal">
          Hide <Kbd>⌘`</Kbd>
        </Button>
      </div>
      <div className={styles.body}>
        {current ? (
          <Suspense fallback={<p className={styles.note}>Loading terminal…</p>}>
            <TerminalView key={current.ptyId} threadId={threadId} ptyId={current.ptyId} />
          </Suspense>
        ) : (
          <p className={styles.note}>No terminal yet — press + to start one in the worktree.</p>
        )}
      </div>
      {menu ? (
        <ContextMenu label="Terminal tab" position={menu.at} items={menuItems(menu.tab)} onClose={() => setMenu(undefined)} />
      ) : null}
    </div>
  );
}
