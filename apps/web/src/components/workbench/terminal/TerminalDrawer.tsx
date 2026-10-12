import { Suspense, lazy, useEffect, useLayoutEffect, useRef } from "react";
import {
  createPty,
  ensurePtys,
  killPty,
  setActivePty,
  setDrawerHeight,
  toggleDrawer,
  useTerminals,
} from "../../../state/terminals.ts";
import { Button } from "../../ui/Button.tsx";
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

function title(ptyId: string, given: string | undefined, index: number): string {
  return given ?? `sh ${index + 1}`;
}

/** `` ⌘` `` drawer: one tab per pty of the thread; ptys outlive the drawer. */
export function TerminalDrawer({ threadId }: { threadId: string }) {
  const open = useTerminals((s) => s.drawerOpen);
  const height = useTerminals((s) => s.height);
  const tabs = useTerminals((s) => s.tabs[threadId]) ?? [];
  const active = useTerminals((s) => s.active[threadId]);
  const onDrag = useDragHeight();
  const drawer = useRef<HTMLDivElement>(null);

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
    <div ref={drawer} className={styles.drawer} aria-label="Terminal">
      <div
        className={styles.grip}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal"
        onMouseDown={onDrag}
      />
      <div className={styles.tabs} role="tablist">
        {tabs.map((tab, index) => (
          <span key={tab.ptyId} className={styles.tabWrap}>
            <button
              type="button"
              role="tab"
              aria-selected={tab.ptyId === current?.ptyId}
              className={`${styles.tab} ${tab.ptyId === current?.ptyId ? styles.activeTab : ""}`}
              onClick={() => setActivePty(threadId, tab.ptyId)}
            >
              {title(tab.ptyId, tab.title, index)}
              {tab.alive ? "" : " ·exited"}
            </button>
            <Button
              variant="quiet"
              aria-label={`Close ${title(tab.ptyId, tab.title, index)}`}
              onClick={() => void killPty(threadId, tab.ptyId)}
            >
              ×
            </Button>
          </span>
        ))}
        <Button
          variant="quiet"
          aria-label="New terminal"
          title="New terminal"
          onClick={() => void createPty(threadId, DEFAULT_COLS, DEFAULT_ROWS)}
        >
          +
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
    </div>
  );
}
