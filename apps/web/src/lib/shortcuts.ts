import { applyStash, getDraft, stashDraft } from "../state/drafts.ts";
import { useModel } from "../state/model.ts";
import { useUi } from "../state/ui.ts";
import { closeActiveTab, openSearchTab, setQuickOpen, toggleTree } from "../state/workbench.ts";
import { toggleDrawer } from "../state/terminals.ts";
import { toggleTheme } from "../state/settings.ts";
import { effortsOf, nextEffort, threadProviderStatus, useProvidersStore } from "../state/providers.ts";
import { showToast } from "../state/toast.ts";
import { updateThread } from "./threadActions.ts";
import { useServerSettings } from "../state/serverSettings.ts";
import { RAIL_BINDINGS, formatBinding, normalizeEvent, type BindingEntry } from "./keybindings.ts";

/**
 * When an entry applies. `thread` needs a selected thread, `workbench` needs one
 * with the workbench on screen (focus mode is not "thread"), `experts` needs the
 * board open. `rail` entries are single keys dispatched by the rail's own handler
 * (`shell/useInboxKeys` via `matchRailBinding`), never by `handleShortcut`; they are
 * listed here so Settings › Keyboard shows and rebinds them. Anything else is always live.
 */
export type ShortcutScope = "always" | "thread" | "workbench" | "experts" | "rail";

export interface Shortcut {
  id: string;
  /** display form, e.g. `⌘⇧D` */
  keys: string;
  label: string;
  group: "Navigation" | "View" | "Thread" | "Workbench" | "Rail";
  /** `KeyboardEvent.key` (lowercased) this binds to; omitted when another surface owns it */
  key?: string;
  /** shift requirement; undefined means "don't care" */
  shift?: boolean;
  /**
   * Browsers reserve ⌘N / ⌘W, so outside the desktop shell the entry binds to
   * this `KeyboardEvent.code` with ⌥ instead and shows `altKeys`.
   */
  browserAlt?: { code: string; keys: string };
  /** a bare shipped binding in `keybindings.ts` form (`j`, `enter`), for keys with no modifier */
  binding?: string;
  /** context the entry needs; defaults to "always" */
  when?: ShortcutScope;
  /** performs the action; `false` means it does not apply right now */
  run?: () => boolean | void;
}

/** True inside the Tauri shell, where ⌘N / ⌘W are ours to bind. */
export function isDesktopShell(): boolean {
  return typeof window !== "undefined" && ("__TAURI__" in window || "__TAURI_INTERNALS__" in window);
}

/** The label to show for a shortcut in this environment (`⌥N` in a browser tab, or the user's own chord). */
export function shortcutKeys(shortcut: Shortcut, overrides: Record<string, string> = {}): string {
  const custom = overrides[shortcut.id];
  if (custom) return formatBinding(custom);
  return shortcut.browserAlt && !isDesktopShell() ? shortcut.browserAlt.keys : shortcut.keys;
}

/** The shipped binding of an entry in this environment, in `keybindings.ts` form; undefined for surface-owned entries. */
export function defaultBinding(shortcut: Shortcut): string | undefined {
  if (!shortcut.run) return undefined;
  if (shortcut.binding !== undefined) return shortcut.binding;
  if (shortcut.browserAlt && !isDesktopShell()) {
    const key = shortcut.browserAlt.code.replace(/^(Key|Digit)/, "").toLowerCase();
    return `alt+${key}`;
  }
  if (shortcut.key === undefined) return undefined;
  return `mod${shortcut.shift ? "+shift" : ""}+${shortcut.key}`;
}

/** Every rebindable entry with the chord it answers to right now. */
export function bindingEntries(overrides: Record<string, string>): BindingEntry[] {
  const entries: BindingEntry[] = [];
  for (const shortcut of SHORTCUTS) {
    const fallback = defaultBinding(shortcut);
    const binding = overrides[shortcut.id] || fallback;
    if (binding === undefined) continue;
    entries.push({
      id: shortcut.id,
      label: shortcut.label,
      // rail keys are live wherever focus is outside a text field: as wide as "always"
      ...(shortcut.when && shortcut.when !== "rail" ? { when: shortcut.when } : {}),
      binding,
      isDefault: !overrides[shortcut.id],
    });
  }
  return entries;
}

/**
 * ⌘⇧E is shared with "Toggle file tree": effort owns it while the thread column
 * has focus (or the workbench is hidden); anywhere else it falls through to the tree.
 */
function cycleEffort(): boolean {
  const id = threadId();
  if (!id) return false;
  const active = typeof document !== "undefined" ? document.activeElement : null;
  const inThread = active instanceof Element && active.closest("[data-thread-column]") !== null;
  if (!inThread && ui().focusMode !== "thread") return false;
  const thread = useModel.getState().model.threads[id];
  if (!thread) return false;
  const models = threadProviderStatus(useProvidersStore.getState().providers, thread)?.models ?? [];
  const efforts = effortsOf(models, thread.model);
  if (efforts.length === 0) return false;
  const next = nextEffort(efforts, thread.effort);
  updateThread(id, { effort: next });
  const label = efforts.find((e) => e.id === next)?.label ?? "Default";
  showToast(thread.status === "running" ? `Effort: ${label} · applies from the next turn` : `Effort: ${label}`);
  return true;
}

/** Whether the current UI state satisfies a scope. */
export function scopeApplies(scope: ShortcutScope = "always"): boolean {
  const state = ui();
  if (scope === "always") return true;
  // dispatched by the rail's key handler, not the global map or the palette
  if (scope === "rail") return false;
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
 * The rail's single keys, read from the same `RAIL_BINDINGS` (ids and defaults) the rail's
 * handler matches against, so a rebinding saved under `rail.next` moves the key there too.
 * `run` only marks them rebindable in Settings; `when: "rail"` keeps `handleShortcut` and the
 * palette off them.
 */
const RAIL_SHORTCUTS: Shortcut[] = RAIL_BINDINGS.map((entry) => ({
  id: entry.id,
  keys: entry.binding === "enter" ? "↵" : entry.binding,
  label: entry.label,
  group: "Rail",
  binding: entry.binding,
  when: "rail",
  run: () => false,
}));

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
    browserAlt: { code: "KeyN", keys: "⌥N" },
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
  { id: "send", keys: "⌘↵", label: "Send in background (while running: the selected follow-up mode)", group: "Thread", when: "thread" },
  {
    id: "stash", keys: "⌘S", label: "Stash prompt / apply stash (composer focused)", group: "Thread", key: "s", shift: false,
    when: "thread",
    run: () => {
      const id = threadId();
      const active = typeof document !== "undefined" ? document.activeElement : null;
      // Monaco owns ⌘S everywhere but the composer
      if (!id || !(active instanceof HTMLTextAreaElement) || active.getAttribute("aria-label") !== "Message") return false;
      if (getDraft(id) !== undefined) return stashDraft(id) !== undefined;
      return applyStash(id);
    },
  },
  { id: "stop", keys: "Esc", label: "Stop turn / close", group: "Thread", when: "thread" },
  { id: "approve", keys: "y", label: "Approve focused card", group: "Thread", when: "thread" },
  { id: "deny", keys: "n", label: "Deny focused card", group: "Thread", when: "thread" },
  {
    id: "effort", keys: "⌘⇧E", label: "Cycle reasoning effort (thread focused)", group: "Thread", key: "e", shift: true,
    when: "thread",
    run: () => cycleEffort(),
  },
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
    browserAlt: { code: "KeyW", keys: "⌥W" },
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
  ...RAIL_SHORTCUTS,
];

export const SHORTCUT_GROUPS: Shortcut["group"][] = ["Navigation", "View", "Thread", "Workbench", "Rail"];

/** Runs the shortcut bound to this event (⌘/^, ⌥ for the browser alternates, or the user's own chord); returns whether it was handled. */
export function handleShortcut(event: KeyboardEvent): boolean {
  const desktop = isDesktopShell();
  const alt = event.altKey && !event.metaKey && !event.ctrlKey;
  if (!event.metaKey && !event.ctrlKey && !alt) return false;
  const overrides = useServerSettings.getState().settings.keybindings ?? {};
  const chord = normalizeEvent(event);
  if (chord === null) return false;
  const key = event.key.toLowerCase();
  for (const shortcut of SHORTCUTS) {
    if (!shortcut.run) continue;
    const custom = overrides[shortcut.id];
    if (custom) {
      if (custom !== chord) continue;
    } else if (alt) {
      if (desktop || shortcut.browserAlt?.code !== event.code) continue;
      if (shortcut.shift !== undefined && shortcut.shift !== event.shiftKey) continue;
    } else {
      if (shortcut.key !== key) continue;
      if (shortcut.browserAlt && !desktop) continue;
      if (shortcut.shift !== undefined && shortcut.shift !== event.shiftKey) continue;
    }
    // out of context: let the key through to the surface rather than swallowing it
    if (!scopeApplies(shortcut.when)) return false;
    // `false` = not right now: a later entry on the same key (⌘⇧E effort → file tree) may take it
    if (shortcut.run() !== false) return true;
  }
  return false;
}
