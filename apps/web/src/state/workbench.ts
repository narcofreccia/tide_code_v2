import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { scopedStateStorage } from "./envStorage.ts";
import { useUi, type FocusMode } from "./ui.ts";

/** Changes is always the first tab of a thread; Search and files follow it. */
export type WorkbenchTab =
  | { kind: "changes" }
  | { kind: "search" }
  | { kind: "experts" }
  | { kind: "file"; path: string; pinned?: boolean }
  /** R11: a dev server in an iframe; one per thread, its URL editable in place */
  | { kind: "preview"; url: string }
  /** R16: a side chat of this thread, beside it in the workbench */
  | { kind: "side"; threadId: string };

export const CHANGES_TAB: WorkbenchTab = { kind: "changes" };

export function tabKey(tab: WorkbenchTab): string {
  if (tab.kind === "file") return `file:${tab.path}`;
  return tab.kind === "side" ? `side:${tab.threadId}` : tab.kind;
}

export interface RevealTarget {
  line: number;
  column: number;
  /** bumped on every request so the editor re-reveals the same line twice */
  nonce: number;
}

export interface EditorStatus {
  threadId: string;
  path: string;
  line: number;
  column: number;
  language: string;
}

/** The file tree remembers its own visibility per layout: Split (narrow) and Code (full). */
export type TreeLayout = "split" | "code";

export const DEFAULT_TREE: Record<TreeLayout, boolean> = { split: false, code: true };

export function treeLayoutOf(mode: FocusMode): TreeLayout {
  return mode === "workbench" ? "code" : "split";
}

interface WorkbenchState {
  /** threadId → ordered tabs; index 0 is always Changes */
  tabs: Record<string, WorkbenchTab[]>;
  /** threadId → active tab key */
  active: Record<string, string>;
  /** the tree as last shown; kept for callers that read it, follows `treeByMode` */
  treeVisible: boolean;
  treeByMode: Record<TreeLayout, boolean>;
  quickOpen: boolean;
  /** `threadId:path` → where the next editor mount should jump */
  reveal: Record<string, RevealTarget>;
  editorStatus: EditorStatus | null;
}

export const WORKBENCH_STORAGE_KEY = "tide.workbench";

export const useWorkbench = create<WorkbenchState>()(
  persist(
    (): WorkbenchState => ({
      tabs: {},
      active: {},
      treeVisible: false,
      treeByMode: { ...DEFAULT_TREE },
      quickOpen: false,
      reveal: {},
      editorStatus: null,
    }),
    {
      name: WORKBENCH_STORAGE_KEY,
      // R9: per-thread tabs live under the owning environment's key (`tide.workbench@<envId>`)
      storage: createJSONStorage(() => scopedStateStorage),
      // paths only — no file contents, no scroll state
      partialize: (s) => ({ tabs: s.tabs, active: s.active, treeVisible: s.treeVisible, treeByMode: s.treeByMode }),
    },
  ),
);

export function threadTabs(threadId: string): WorkbenchTab[] {
  const tabs = useWorkbench.getState().tabs[threadId];
  return tabs && tabs.length > 0 ? tabs : [CHANGES_TAB];
}

export function useThreadTabs(threadId: string | undefined): WorkbenchTab[] {
  const tabs = useWorkbench((s) => (threadId ? s.tabs[threadId] : undefined));
  return tabs && tabs.length > 0 ? tabs : [CHANGES_TAB];
}

export function activeTab(threadId: string): WorkbenchTab {
  const key = useWorkbench.getState().active[threadId];
  const tabs = threadTabs(threadId);
  return tabs.find((t) => tabKey(t) === key) ?? tabs[0] ?? CHANGES_TAB;
}

export function useActiveTab(threadId: string | undefined): WorkbenchTab {
  const key = useWorkbench((s) => (threadId ? s.active[threadId] : undefined));
  const tabs = useThreadTabs(threadId);
  return tabs.find((t) => tabKey(t) === key) ?? tabs[0] ?? CHANGES_TAB;
}

function write(threadId: string, tabs: WorkbenchTab[], active?: string): void {
  useWorkbench.setState((s) => ({
    tabs: { ...s.tabs, [threadId]: tabs },
    ...(active === undefined ? {} : { active: { ...s.active, [threadId]: active } }),
  }));
}

export function setActiveTab(threadId: string, tab: WorkbenchTab): void {
  useWorkbench.setState((s) => ({ active: { ...s.active, [threadId]: tabKey(tab) } }));
}

export interface OpenFileOptions {
  line?: number;
  column?: number;
  pinned?: boolean;
  /** open in the background (tree "open to the side" style) */
  background?: boolean;
}

/** Opens (or focuses) a file tab, optionally scheduling a jump to a line. */
export function openFileTab(threadId: string, path: string, options: OpenFileOptions = {}): void {
  const tabs = threadTabs(threadId);
  const existing = tabs.find((t) => t.kind === "file" && t.path === path);
  const next = existing
    ? tabs
    : [...tabs, { kind: "file" as const, path, ...(options.pinned ? { pinned: true } : {}) }];
  write(threadId, next, options.background ? undefined : `file:${path}`);
  if (options.line !== undefined) {
    useWorkbench.setState((s) => {
      const key = `${threadId}:${path}`;
      const nonce = (s.reveal[key]?.nonce ?? 0) + 1;
      return { reveal: { ...s.reveal, [key]: { line: options.line ?? 1, column: options.column ?? 1, nonce } } };
    });
  }
}

/**
 * The Experts board as a workbench tab, so selecting an expert's thread keeps the
 * board in view. Mounted right after Changes and never auto-focused.
 */
export function openExpertsTab(threadId: string, focus = false): void {
  const tabs = threadTabs(threadId);
  const next = tabs.some((t) => t.kind === "experts")
    ? tabs
    : [tabs[0] ?? CHANGES_TAB, { kind: "experts" as const }, ...tabs.slice(1)];
  write(threadId, next, focus ? "experts" : undefined);
}

/** Opens (or retargets) the thread's Preview tab and focuses it. */
export function openPreviewTab(threadId: string, url: string): void {
  const tabs = threadTabs(threadId);
  const next = tabs.some((t) => t.kind === "preview")
    ? tabs.map((t) => (t.kind === "preview" ? { kind: "preview" as const, url } : t))
    : [...tabs, { kind: "preview" as const, url }];
  write(threadId, next, "preview");
}

/** R16: opens (or focuses) a side chat's tab in its parent's workbench. */
export function openSideTab(parentId: string, sideId: string): void {
  const tabs = threadTabs(parentId);
  const next = tabs.some((t) => t.kind === "side" && t.threadId === sideId) ? tabs : [...tabs, { kind: "side" as const, threadId: sideId }];
  write(parentId, next, `side:${sideId}`);
}

/** R16: closes a side chat's tab; the side thread itself is left alone. */
export function closeSideTab(parentId: string, sideId: string): void {
  closeTab(parentId, { kind: "side", threadId: sideId });
}

export function openSearchTab(threadId: string): void {
  const tabs = threadTabs(threadId);
  const next = tabs.some((t) => t.kind === "search") ? tabs : [tabs[0] ?? CHANGES_TAB, { kind: "search" as const }, ...tabs.slice(1)];
  write(threadId, next, "search");
}

export function takeReveal(threadId: string, path: string): RevealTarget | undefined {
  return useWorkbench.getState().reveal[`${threadId}:${path}`];
}

export function closeTab(threadId: string, tab: WorkbenchTab): void {
  if (tab.kind === "changes") return;
  const tabs = threadTabs(threadId);
  const key = tabKey(tab);
  const at = tabs.findIndex((t) => tabKey(t) === key);
  if (at === -1) return;
  const next = tabs.filter((_, i) => i !== at);
  const wasActive = tabKey(activeTab(threadId)) === key;
  const fallback = next[Math.min(next.length - 1, at)] ?? CHANGES_TAB;
  write(threadId, next, wasActive ? tabKey(fallback) : undefined);
}

/** ⌘W: closes the active tab unless it is Changes or a pinned file. */
export function closeActiveTab(threadId: string): void {
  const tab = activeTab(threadId);
  if (tab.kind === "file" && tab.pinned) return;
  closeTab(threadId, tab);
}

export function togglePin(threadId: string, path: string): void {
  const tabs = threadTabs(threadId);
  const at = tabs.findIndex((t) => t.kind === "file" && t.path === path);
  const tab = tabs[at];
  if (at === -1 || !tab || tab.kind !== "file") return;
  const pinned = !tab.pinned;
  const updated: WorkbenchTab = pinned ? { kind: "file", path, pinned: true } : { kind: "file", path };
  const rest = tabs.filter((_, i) => i !== at);
  if (!pinned) {
    rest.splice(at, 0, updated);
    write(threadId, rest);
    return;
  }
  // pinning moves the tab to the front of the file section
  const firstFile = rest.findIndex((t) => t.kind === "file");
  rest.splice(firstFile === -1 ? rest.length : firstFile, 0, updated);
  write(threadId, rest);
}

/** Drag reorder. Changes stays at index 0; everything else may move freely. */
export function moveTab(threadId: string, from: number, to: number): void {
  const tabs = threadTabs(threadId);
  const moved = tabs[from];
  if (!moved || moved.kind === "changes" || from === to) return;
  const target = Math.min(tabs.length - 1, Math.max(1, to));
  const rest = tabs.filter((_, i) => i !== from);
  rest.splice(target, 0, moved);
  write(threadId, rest);
}

const currentLayout = (): TreeLayout => treeLayoutOf(useUi.getState().focusMode);

/** Shows or hides the tree in the current layout; the choice sticks to that layout. */
export function setTreeVisible(visible: boolean, layout: TreeLayout = currentLayout()): void {
  useWorkbench.setState((s) => ({ treeVisible: visible, treeByMode: { ...s.treeByMode, [layout]: visible } }));
}

export function toggleTree(): void {
  const layout = currentLayout();
  setTreeVisible(!(useWorkbench.getState().treeByMode[layout] ?? DEFAULT_TREE[layout]), layout);
}

/** The tree's visibility in the layout on screen (open by default in Code, closed in Split). */
export function useTreeVisible(): boolean {
  const layout = treeLayoutOf(useUi((s) => s.focusMode));
  return useWorkbench((s) => s.treeByMode?.[layout] ?? DEFAULT_TREE[layout]);
}

export function setQuickOpen(open: boolean): void {
  useWorkbench.setState({ quickOpen: open });
}

export function setEditorStatus(status: EditorStatus | null): void {
  useWorkbench.setState({ editorStatus: status });
}

/** Drops the editor status when it belongs to a file that is no longer shown. */
export function clearEditorStatus(threadId: string, path: string): void {
  const current = useWorkbench.getState().editorStatus;
  if (current && current.threadId === threadId && current.path === path) {
    useWorkbench.setState({ editorStatus: null });
  }
}

export function resetWorkbench(): void {
  useWorkbench.setState({ tabs: {}, active: {}, treeVisible: false, treeByMode: { ...DEFAULT_TREE }, quickOpen: false, reveal: {}, editorStatus: null });
}
