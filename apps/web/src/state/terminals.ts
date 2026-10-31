import { create } from "zustand";
import { persist } from "zustand/middleware";
import { call, useModel } from "./model.ts";
import { onReconnect } from "./reconnect.ts";
import { showToast } from "./toast.ts";

/** why Tide opened the tab: `resume` runs the harness's own resume command (one per thread) */
export type PtyPurpose = "resume";

export interface PtyTab {
  ptyId: string;
  title?: string;
  alive: boolean;
  purpose?: PtyPurpose;
}

interface TerminalsState {
  drawerOpen: boolean;
  /** drawer height in px, clamped on set */
  height: number;
  /** threadId → ptys known to the client (server keeps them alive across threads) */
  tabs: Record<string, PtyTab[]>;
  active: Record<string, string | undefined>;
  loaded: Record<string, boolean>;
}

export const TERMINALS_STORAGE_KEY = "tide.terminals";
export const MIN_HEIGHT = 100;
export const MAX_HEIGHT = 800;

export const useTerminals = create<TerminalsState>()(
  persist(
    (): TerminalsState => ({ drawerOpen: false, height: 240, tabs: {}, active: {}, loaded: {} }),
    {
      name: TERMINALS_STORAGE_KEY,
      partialize: (s) => ({ drawerOpen: s.drawerOpen, height: s.height }),
    },
  ),
);

export function toggleDrawer(): void {
  useTerminals.setState((s) => ({ drawerOpen: !s.drawerOpen }));
}

export function setDrawerOpen(drawerOpen: boolean): void {
  useTerminals.setState({ drawerOpen });
}

export function setDrawerHeight(height: number): void {
  useTerminals.setState({ height: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(height))) });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setTabs(threadId: string, tabs: PtyTab[], active?: string | undefined): void {
  useTerminals.setState((s) => ({
    tabs: { ...s.tabs, [threadId]: tabs },
    ...(active === undefined ? {} : { active: { ...s.active, [threadId]: active } }),
  }));
}

export function setActivePty(threadId: string, ptyId: string | undefined): void {
  useTerminals.setState((s) => ({ active: { ...s.active, [threadId]: ptyId } }));
}

/** `pty.list` once per thread when the drawer opens; ptys outlive the client. */
export async function ensurePtys(threadId: string, force = false): Promise<void> {
  if (!force && useTerminals.getState().loaded[threadId]) return;
  useTerminals.setState((s) => ({ loaded: { ...s.loaded, [threadId]: true } }));
  try {
    const result = await call("pty.list", { threadId });
    // the server does not know why a pty was opened; keep the client's tag
    const known = new Map((useTerminals.getState().tabs[threadId] ?? []).map((t) => [t.ptyId, t.purpose]));
    const tabs: PtyTab[] = result.ptys.map((p) => {
      const purpose = known.get(p.ptyId);
      return {
        ptyId: p.ptyId,
        alive: p.alive,
        ...(p.title === undefined ? {} : { title: p.title }),
        ...(purpose === undefined ? {} : { purpose }),
      };
    });
    const current = useTerminals.getState().active[threadId];
    const active = tabs.some((t) => t.ptyId === current) ? current : tabs[0]?.ptyId;
    setTabs(threadId, tabs);
    setActivePty(threadId, active);
  } catch (error) {
    useTerminals.setState((s) => ({ loaded: { ...s.loaded, [threadId]: false } }));
    showToast(`Terminals unavailable: ${message(error)}`);
  }
}

export async function createPty(threadId: string, cols: number, rows: number, purpose?: PtyPurpose): Promise<string | undefined> {
  try {
    const { ptyId } = await call("pty.create", { threadId, cols, rows });
    const tab: PtyTab = { ptyId, alive: true, ...(purpose === undefined ? {} : { purpose }) };
    const tabs = [...(useTerminals.getState().tabs[threadId] ?? []), tab];
    setTabs(threadId, tabs, ptyId);
    return ptyId;
  } catch (error) {
    showToast(`New terminal failed: ${message(error)}`);
    return undefined;
  }
}

export async function killPty(threadId: string, ptyId: string): Promise<void> {
  const tabs = (useTerminals.getState().tabs[threadId] ?? []).filter((t) => t.ptyId !== ptyId);
  const wasActive = useTerminals.getState().active[threadId] === ptyId;
  setTabs(threadId, tabs, wasActive ? tabs[tabs.length - 1]?.ptyId : undefined);
  try {
    await call("pty.kill", { ptyId });
  } catch {
    /* already gone */
  }
}

/** The thread's live tab opened for `purpose`, if any (exited or closed tabs do not count). */
export function livePurposeTab(threadId: string, purpose: PtyPurpose): PtyTab | undefined {
  return (useTerminals.getState().tabs[threadId] ?? []).find((t) => t.purpose === purpose && t.alive);
}

export function markExited(threadId: string, ptyId: string): void {
  const tabs = (useTerminals.getState().tabs[threadId] ?? []).map((t) =>
    t.ptyId === ptyId ? { ...t, alive: false } : t,
  );
  setTabs(threadId, tabs);
}

export function writePty(ptyId: string, data: string): void {
  void call("pty.write", { ptyId, data }).catch(() => undefined);
}

export function resizePty(ptyId: string, cols: number, rows: number): void {
  void call("pty.resize", { ptyId, cols, rows }).catch(() => undefined);
}

// ptys outlive the socket on the server, so a reconnect re-lists them instead of
// leaving `loaded` blocking a fresh read.
onReconnect((envId) => {
  for (const threadId of Object.keys(useTerminals.getState().loaded)) {
    // R9: only the environment that came back lost its attachments
    if (envId !== undefined && useModel.getState().ownership.threads[threadId] !== envId) continue;
    void ensurePtys(threadId, true);
  }
});

export function resetTerminals(): void {
  useTerminals.setState({ drawerOpen: false, height: 240, tabs: {}, active: {}, loaded: {} });
}
