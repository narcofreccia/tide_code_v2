import { create } from "zustand";
import { persist } from "zustand/middleware";

export type FocusMode = "thread" | "split" | "workbench";
export type View = "mission" | "thread" | "settings";
export type SettingsSection = "providers" | "git" | "appearance" | "keyboard" | "remote" | "about";

export const SETTINGS_SECTIONS: SettingsSection[] = [
  "providers",
  "git",
  "appearance",
  "keyboard",
  "remote",
  "about",
];

interface UiState {
  view: View;
  selectedProjectId: string | null;
  selectedThreadId: string | null;
  newProjectOpen: boolean;
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
  showMission: () => void;
  showSettings: () => void;
  toggleSettings: () => void;
  closeSettings: () => void;
  setSettingsSection: (section: SettingsSection) => void;
  setNewProjectOpen: (open: boolean) => void;
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
      newProjectOpen: false,
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
