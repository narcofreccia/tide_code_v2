import { useModel } from "../state/model.ts";
import { useUi } from "../state/ui.ts";
import { closeActiveTab, openSearchTab, setQuickOpen, toggleTree } from "../state/workbench.ts";
import { toggleDrawer } from "../state/terminals.ts";
import { toggleTheme } from "../state/settings.ts";

/**
 * When an entry applies. `thread` needs a selected thread, `workbench` needs one
 * with the workbench on screen (focus mode is not "thread"), `experts` needs the
 * board open. Anything else is always live.
 */
export type ShortcutScope = "always" | "thread" | "workbench" | "experts";

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
  /** context the entry needs; defaults to "always" */
  when?: ShortcutScope;
  /** performs the action; `false` means it does not apply right now */
  run?: () => boolean | void;
}

/** Whether the current UI state satisfies a scope. */
export function scopeApplies(scope: ShortcutScope = "always"): boolean {
  const state = ui();
  if (scope === "always") return true;
  if (scope === "experts") return state.view === "experts" && state.selectedExpertsSessionId !== null;
  if (state.selectedThreadId === null) return false;
  return scope === "thread" || state.focusMode !== "thread";
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
    when: "always",
    run: () => ui().setPaletteOpen(true),
  },
  {
    id: "new-thread", keys: "⌘N", label: "New thread", group: "Navigation", key: "n", shift: false,
    when: "always",
    run: () => {
      const state = ui();
      const projectId = state.selectedProjectId ?? currentProjectId();
      if (projectId === undefined) return false;
      state.setNewThreadProject(projectId);
    },
  },
  {
    id: "new-experts", keys: "⌘⇧X", label: "New experts session", group: "Navigation", key: "x", shift: true,
    when: "always",
    run: () => {
      const state = ui();
      const projectId = state.selectedProjectId ?? currentProjectId();
      if (projectId === undefined) return false;
      state.setNewExpertsProject(projectId);
    },
  },
  { id: "mission", keys: "⌘0", label: "Mission Control", group: "Navigation", key: "0", when: "always", run: () => ui().showMission() },
  { id: "settings", keys: "⌘,", label: "Settings", group: "Navigation", key: ",", when: "always", run: () => ui().showSettings() },
  { id: "focus-thread", keys: "⌘1", label: "Focus: thread", group: "View", key: "1", when: "thread", run: () => ui().setFocusMode("thread") },
  { id: "focus-split", keys: "⌘2", label: "Focus: split", group: "View", key: "2", when: "thread", run: () => ui().setFocusMode("split") },
  { id: "focus-workbench", keys: "⌘3", label: "Focus: workbench", group: "View", key: "3", when: "thread", run: () => ui().setFocusMode("workbench") },
  {
    id: "theme", keys: "⌘⇧L", label: "Toggle light/dark", group: "View", key: "l", shift: true,
    when: "always",
    run: () => {
      toggleTheme();
    },
  },
  { id: "rail", keys: "⌘B", label: "Toggle rail", group: "View", key: "b", shift: false, when: "always", run: () => ui().toggleRail() },
  { id: "send", keys: "⌘↵", label: "Send message", group: "Thread", when: "thread" },
  { id: "stop", keys: "Esc", label: "Stop turn / close", group: "Thread", when: "thread" },
  { id: "approve", keys: "y", label: "Approve focused card", group: "Thread", when: "thread" },
  { id: "deny", keys: "n", label: "Deny focused card", group: "Thread", when: "thread" },
  { id: "terminal", keys: "⌘`", label: "Terminal drawer", group: "Workbench", key: "`", when: "workbench", run: () => (toggleDrawer(), true) },
  {
    id: "quick-open", keys: "⌘P", label: "Open file in worktree", group: "Workbench", key: "p", shift: false,
    when: "workbench",
    run: () => (setQuickOpen(true), true),
  },
  {
    id: "search", keys: "⌘⇧F", label: "Search in worktree", group: "Workbench", key: "f", shift: true,
    when: "workbench",
    run: () => {
      const id = threadId();
      if (!id) return false;
      openSearchTab(id);
    },
  },
  { id: "tree", keys: "⌘⇧E", label: "Toggle file tree", group: "Workbench", key: "e", shift: true, when: "workbench", run: () => toggleTree() },
  {
    id: "close-tab", keys: "⌘W", label: "Close tab", group: "Workbench", key: "w", shift: false,
    when: "workbench",
    run: () => {
      const id = threadId();
      if (!id) return false;
      closeActiveTab(id);
    },
  },
  { id: "save", keys: "⌘S", label: "Save file", group: "Workbench", when: "workbench" },
  { id: "diff-layout", keys: "⌘⇧D", label: "Unified / side-by-side diff", group: "Workbench", key: "d", shift: true, when: "workbench", run: () => ui().toggleDiffSideBySide() },
  { id: "prev-turn", keys: "[", label: "Previous turn", group: "Workbench", when: "workbench" },
  { id: "next-turn", keys: "]", label: "Next turn", group: "Workbench", when: "workbench" },
];

export const SHORTCUT_GROUPS: Shortcut["group"][] = ["Navigation", "View", "Thread", "Workbench"];

/** Runs the ⌘/^ shortcut bound to this event; returns whether it was handled. */
export function handleShortcut(event: KeyboardEvent): boolean {
  if (!event.metaKey && !event.ctrlKey) return false;
  const key = event.key.toLowerCase();
  for (const shortcut of SHORTCUTS) {
    if (!shortcut.run || shortcut.key !== key) continue;
    if (shortcut.shift !== undefined && shortcut.shift !== event.shiftKey) continue;
    // out of context: let the key through to the surface rather than swallowing it
    if (!scopeApplies(shortcut.when)) return false;
    return shortcut.run() !== false;
  }
  return false;
}
