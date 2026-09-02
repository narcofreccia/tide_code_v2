import { create } from "zustand";
import { persist } from "zustand/middleware";

export type FocusMode = "thread" | "split" | "workbench";
export type View = "mission" | "thread" | "settings" | "experts";
export type SettingsSection = "providers" | "git" | "appearance" | "keyboard" | "remote" | "about";

export const SETTINGS_SECTIONS: SettingsSection[] = [
  "providers",
  "git",
  "appearance",
  "keyboard",
  "remote",
  "about",
];

/** A thread-scoped modal the palette or the thread header can raise. */
export interface ThreadDialog {
  kind: "archive" | "detach";
  threadId: string;
}

interface UiState {
  view: View;
  selectedProjectId: string | null;
  selectedThreadId: string | null;
  /** the Experts session whose board fills the Thread column (view === "experts") */
  selectedExpertsSessionId: string | null;
  /** the view the board was opened from, so Esc goes back */
  expertsReturnTo: View;
  /** project the create-experts dialog is open for, null when closed */
  newExpertsProjectId: string | null;
  newProjectOpen: boolean;
  /** project the ⌘K / ⌘N new-thread dialog is open for, null when closed */
  newThreadProjectId: string | null;
  /** project whose "Linked repositories" editor is open, null when closed */
  linksProjectId: string | null;
  /** ⌘K command palette */
  paletteOpen: boolean;
  /** archive / detach confirmation, null when none is open */
  threadDialog: ThreadDialog | null;
  focusMode: FocusMode;
  railCollapsed: boolean;
  /** thread column share of the split, 0.2–0.8 */
  splitRatio: number;
  /** Changes tab: side-by-side diff when true, unified when false (⌘⇧D) */
  diffSideBySide: boolean;
  fileListCollapsed: boolean;
  /** last Settings section, persisted */
  settingsSection: SettingsSection;
  /** the view Settings was opened from, so Esc goes back */
  settingsReturnTo: View;
  selectProject: (projectId: string | null) => void;
  selectThread: (threadId: string | null) => void;
  selectExpertsSession: (sessionId: string | null) => void;
  closeExperts: () => void;
  setNewExpertsProject: (projectId: string | null) => void;
  showMission: () => void;
  showSettings: () => void;
  toggleSettings: () => void;
  closeSettings: () => void;
  setSettingsSection: (section: SettingsSection) => void;
  setNewProjectOpen: (open: boolean) => void;
  setNewThreadProject: (projectId: string | null) => void;
  setLinksProject: (projectId: string | null) => void;
  setPaletteOpen: (open: boolean) => void;
  setThreadDialog: (dialog: ThreadDialog | null) => void;
  setFocusMode: (mode: FocusMode) => void;
  toggleRail: () => void;
  setSplitRatio: (ratio: number) => void;
  toggleDiffSideBySide: () => void;
  toggleFileList: () => void;
}

export const UI_STORAGE_KEY = "tide.ui";

/** Only layout preferences persist; selection is per-session. */
export const useUi = create<UiState>()(
  persist(
    (set) => ({
      view: "mission",
      selectedProjectId: null,
      selectedThreadId: null,
      selectedExpertsSessionId: null,
      expertsReturnTo: "mission",
      newExpertsProjectId: null,
      newProjectOpen: false,
      newThreadProjectId: null,
      linksProjectId: null,
      paletteOpen: false,
      threadDialog: null,
      focusMode: "split",
      railCollapsed: false,
      splitRatio: 0.45,
      diffSideBySide: true,
      fileListCollapsed: false,
      settingsSection: "providers",
      settingsReturnTo: "mission",
      selectProject: (selectedProjectId) => set({ selectedProjectId }),
      selectThread: (selectedThreadId) =>
        set(selectedThreadId ? { selectedThreadId, view: "thread" } : { selectedThreadId: null, view: "mission" }),
      selectExpertsSession: (selectedExpertsSessionId) =>
        set((s) =>
          selectedExpertsSessionId === null
            ? { selectedExpertsSessionId: null, view: "mission" }
            : {
                selectedExpertsSessionId,
                view: "experts",
                ...(s.view === "experts" ? {} : { expertsReturnTo: s.view }),
              },
        ),
      closeExperts: () => set((s) => (s.view === "experts" ? { view: s.expertsReturnTo } : s)),
      setNewExpertsProject: (newExpertsProjectId) => set({ newExpertsProjectId }),
      showMission: () => set({ view: "mission" }),
      showSettings: () =>
        set((s) => (s.view === "settings" ? s : { view: "settings", settingsReturnTo: s.view })),
      toggleSettings: () =>
        set((s) =>
          s.view === "settings" ? { view: s.settingsReturnTo } : { view: "settings", settingsReturnTo: s.view },
        ),
      closeSettings: () => set((s) => (s.view === "settings" ? { view: s.settingsReturnTo } : s)),
      setSettingsSection: (settingsSection) => set({ settingsSection }),
      setNewProjectOpen: (newProjectOpen) => set({ newProjectOpen }),
      setNewThreadProject: (newThreadProjectId) => set({ newThreadProjectId }),
      setLinksProject: (linksProjectId) => set({ linksProjectId }),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      setThreadDialog: (threadDialog) => set({ threadDialog }),
      setFocusMode: (focusMode) => set({ focusMode }),
      toggleRail: () => set((s) => ({ railCollapsed: !s.railCollapsed })),
      setSplitRatio: (ratio) => set({ splitRatio: Math.min(0.8, Math.max(0.2, ratio)) }),
      toggleDiffSideBySide: () => set((s) => ({ diffSideBySide: !s.diffSideBySide })),
      toggleFileList: () => set((s) => ({ fileListCollapsed: !s.fileListCollapsed })),
    }),
    {
      name: UI_STORAGE_KEY,
      partialize: (s) => ({
        focusMode: s.focusMode,
        railCollapsed: s.railCollapsed,
        splitRatio: s.splitRatio,
        diffSideBySide: s.diffSideBySide,
        fileListCollapsed: s.fileListCollapsed,
        settingsSection: s.settingsSection,
      }),
    },
  ),
);
