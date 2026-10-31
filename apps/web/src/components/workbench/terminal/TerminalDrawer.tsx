import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useModel } from "../../../state/model.ts";
import { stopStack, useRunSession } from "../../../state/run.ts";
import {
  createPty,
  ensureOwnerPtys,
  ensurePtys,
  runOwnerId,
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

/**
 * R13: the project's run-stack ptys (`ownerId: "run:<projectId>"`), re-listed whenever the session
 * reports a different set of service ptys. Stopping a tab stops its service, not just the shell.
 */
function useStackTabs(open: boolean, projectId: string | undefined): { tabs: PtyTab[]; stop: (tab: PtyTab) => void } {
  const owner = projectId === undefined ? undefined : runOwnerId(projectId);
  const tabs = useTerminals((s) => (owner === undefined ? undefined : s.tabs[owner])) ?? NO_TABS;
  const session = useRunSession(open ? projectId : undefined);
  const signature = Object.values(session?.services ?? {})
    .map((st) => st.ptyId ?? "")
    .sort()
    .join(",");
  useEffect(() => {
    if (open && owner !== undefined) void ensureOwnerPtys(owner, true);
  }, [open, owner, signature]);
  const stop = (tab: PtyTab): void => {
    if (projectId === undefined) return;
    const key = Object.entries(session?.services ?? {}).find(([, st]) => st.ptyId === tab.ptyId)?.[0];
    void stopStack(projectId, key ?? tab.label).then(() => {
      if (owner !== undefined) void ensureOwnerPtys(owner, true);
    });
  };
  return { tabs, stop };
}

const NO_TABS: PtyTab[] = [];

/** `` ⌘` `` drawer: one tab per pty of the thread, then the project's stack; ptys outlive the drawer. */
export function TerminalDrawer({ threadId }: { threadId: string }) {
  const open = useTerminals((s) => s.drawerOpen);
  const height = useTerminals((s) => s.height);
  const tabs = useTerminals((s) => s.tabs[threadId]) ?? NO_TABS;
  const projectId = useModel((s) => s.model.threads[threadId]?.projectId);
  const stack = useStackTabs(open, projectId);
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

  const current = tabs.find((t) => t.ptyId === active) ?? stack.tabs.find((t) => t.ptyId === active) ?? tabs[0];

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
        {stack.tabs.length === 0 ? null : (
          <span className={styles.group} role="presentation">
            <span className={styles.groupLabel}>Stack</span>
            {stack.tabs.map((tab, index) => {
              const name = tab.label ?? tabTitle(tab.title, index);
              const selected = tab.ptyId === current?.ptyId;
              return (
                <span key={tab.ptyId} className={`${styles.tabWrap} ${selected ? styles.activeTab : ""}`}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    className={styles.tab}
                    title={tab.alive ? `${name} (stack)` : `${name} (exited)`}
                    onClick={() => setActivePty(threadId, tab.ptyId)}
                  >
                    <span className={`${styles.dot} ${tab.alive ? "" : styles.dotExited}`} aria-hidden="true" />
                    <span className={styles.tabName}>{name}</span>
                  </button>
                  <button
                    type="button"
                    className={styles.close}
                    aria-label={`Stop ${name}`}
                    title="Stop service"
                    onClick={() => stack.stop(tab)}
                  >
                    <Icon name="stop" size={12} />
                  </button>
                </span>
              );
            })}
          </span>
        )}
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
