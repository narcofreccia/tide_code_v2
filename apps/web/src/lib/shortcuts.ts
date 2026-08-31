import { useModel } from "../state/model.ts";
import { useUi } from "../state/ui.ts";
import { closeActiveTab, openSearchTab, setQuickOpen, toggleTree } from "../state/workbench.ts";
import { toggleDrawer } from "../state/terminals.ts";

export interface Shortcut {
  id: string;
  /** display form, e.g. `⌘⇧D` */
  keys: string;
  label: string;
  group: "Navigation" | "View" | "Thread" | "Workbench";
  /** `KeyboardEvent.key` (lowercased) this binds to; omitted when another surface owns it */
  key?: string;
  /** shift requirement; undefined means "don't care" */
  shift?: boolean;
  /** performs the action; `false` means it does not apply right now */
  run?: () => boolean | void;
}

const ui = () => useUi.getState();
const threadId = (): string | null => ui().selectedThreadId;

/** The project ⌘⇧X targets: the rail's selection, else the selected thread's. */
function currentProjectId(): string | undefined {
  const model = useModel.getState().model;
  const id = ui().selectedThreadId;
  const fromThread = id ? model.threads[id]?.projectId : undefined;
  return fromThread ?? Object.keys(model.projects)[0];
}

/**
 * Single source of truth for the keyboard map: `handleShortcut` dispatches from it
 * and Settings › Keyboard renders it. Entries without `run` are owned by a surface
 * (composer, cards, Monaco) and appear in the table only.
 */
export const SHORTCUTS: Shortcut[] = [
  {
    id: "palette", keys: "⌘K", label: "Command palette", group: "Navigation", key: "k", shift: false,
    run: () => ui().setPaletteOpen(true),
  },
  { id: "new-thread", keys: "⌘N", label: "New thread", group: "Navigation" },
  {
    id: "new-experts", keys: "⌘⇧X", label: "New experts session", group: "Navigation", key: "x", shift: true,
    run: () => {
      const state = ui();
      const projectId = state.selectedProjectId ?? currentProjectId();
      if (projectId === undefined) return false;
      state.setNewExpertsProject(projectId);
    },
  },
  { id: "mission", keys: "⌘0", label: "Mission Control", group: "Navigation", key: "0", run: () => ui().showMission() },
  { id: "settings", keys: "⌘,", label: "Settings", group: "Navigation", key: ",", run: () => ui().showSettings() },
  { id: "focus-thread", keys: "⌘1", label: "Focus: thread", group: "View", key: "1", run: () => ui().setFocusMode("thread") },
  { id: "focus-split", keys: "⌘2", label: "Focus: split", group: "View", key: "2", run: () => ui().setFocusMode("split") },
  { id: "focus-workbench", keys: "⌘3", label: "Focus: workbench", group: "View", key: "3", run: () => ui().setFocusMode("workbench") },
  { id: "rail", keys: "⌘B", label: "Toggle rail", group: "View", key: "b", shift: false, run: () => ui().toggleRail() },
  { id: "send", keys: "⌘↵", label: "Send message", group: "Thread" },
  { id: "stop", keys: "Esc", label: "Stop turn / close", group: "Thread" },
  { id: "approve", keys: "y", label: "Approve focused card", group: "Thread" },
  { id: "deny", keys: "n", label: "Deny focused card", group: "Thread" },
  { id: "terminal", keys: "⌘`", label: "Terminal drawer", group: "Workbench", key: "`", run: () => threadId() !== null && (toggleDrawer(), true) },
  {
    id: "quick-open", keys: "⌘P", label: "Open file in worktree", group: "Workbench", key: "p", shift: false,
    run: () => threadId() !== null && (setQuickOpen(true), true),
  },
  {
    id: "search", keys: "⌘⇧F", label: "Search in worktree", group: "Workbench", key: "f", shift: true,
    run: () => {
      const id = threadId();
      if (!id) return false;
      openSearchTab(id);
      if (ui().focusMode === "thread") ui().setFocusMode("split");
    },
  },
  { id: "tree", keys: "⌘⇧E", label: "Toggle file tree", group: "Workbench", key: "e", shift: true, run: () => toggleTree() },
  {
    id: "close-tab", keys: "⌘W", label: "Close tab", group: "Workbench", key: "w", shift: false,
    run: () => {
      const id = threadId();
      if (!id) return false;
      closeActiveTab(id);
    },
  },
  { id: "save", keys: "⌘S", label: "Save file", group: "Workbench" },
  { id: "diff-layout", keys: "⌘⇧D", label: "Unified / side-by-side diff", group: "Workbench", key: "d", shift: true, run: () => ui().toggleDiffSideBySide() },
  { id: "prev-turn", keys: "[", label: "Previous turn", group: "Workbench" },
  { id: "next-turn", keys: "]", label: "Next turn", group: "Workbench" },
];

export const SHORTCUT_GROUPS: Shortcut["group"][] = ["Navigation", "View", "Thread", "Workbench"];

/** Runs the ⌘/^ shortcut bound to this event; returns whether it was handled. */
export function handleShortcut(event: KeyboardEvent): boolean {
  if (!event.metaKey && !event.ctrlKey) return false;
  const key = event.key.toLowerCase();
  for (const shortcut of SHORTCUTS) {
    if (!shortcut.run || shortcut.key !== key) continue;
    if (shortcut.shift !== undefined && shortcut.shift !== event.shiftKey) continue;
    return shortcut.run() !== false;
  }
  return false;
}
