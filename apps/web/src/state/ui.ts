import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useModel } from "./model.ts";

export type FocusMode = "thread" | "split" | "workbench";
/** `threads` is the per-project "All threads" list opened from Mission Control. */
/** `prs` is the PR tab (R10), `usage` the usage glass-box page. */
export type View = "mission" | "thread" | "settings" | "experts" | "threads" | "prs" | "usage";
export type SettingsSection = "general" | "inbox" | "notifications" | "providers" | "git" | "decisions" | "automations" | "teams" | "appearance" | "keyboard" | "environments" | "glassBox" | "about";

export const SETTINGS_SECTIONS: SettingsSection[] = [
  "general",
  "inbox",
  "notifications",
  "providers",
  "git",
  "decisions",
  "automations",
  "teams",
  "appearance",
  "keyboard",
  "environments",
  "glassBox",
  "about",
];

/** A thread-scoped modal the palette or the thread header can raise. */
export interface ThreadDialog {
  kind: "archive" | "delete" | "detach" | "rollback" | "fork";
  threadId: string;
  /** rollback / fork: the turn the action starts from */
  turnId?: string;
}

/** A project-scoped modal raised from the rail's context menu. */
export interface ProjectDialog {
  kind: "rename" | "archive";
  projectId: string;
}

export type NewThreadTab = "thread" | "team";

export interface NewThreadRequest {
  projectId?: string;
  parentThreadId?: string;
  tab?: NewThreadTab;
}

interface UiState {
  view: View;
  selectedProjectId: string | null;
  selectedThreadId: string | null;
  /** the Experts session whose board fills the Thread column (view === "experts") */
  selectedExpertsSessionId: string | null;
  /** the view the board was opened from, so Esc goes back */
  expertsReturnTo: View;
  /** project whose "All threads" list fills the content area (view === "threads") */
  allThreadsProjectId: string | null;
  /** the PR tab's project filter; null is "All projects" */
  prsProjectId: string | null;
  /** thread whose "Link a PR…" dialog is open, null when closed */
  linkPrThreadId: string | null;
  /** project the create-experts dialog is open for, null when closed */
  newExpertsProjectId: string | null;
  newProjectOpen: boolean;
  /** project the ⌘K / ⌘N new-thread dialog is open for, null when closed */
  newThreadProjectId: string | null;
  /** `+ child` / "New child thread": the parent the new-thread form is prefilled with */
  newThreadParentId: string | null;
  /** which side of the new-thread form opens first */
  newThreadTab: NewThreadTab;
  /** project rename / archive dialog raised from the rail */
  projectDialog: ProjectDialog | null;
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
  /** opens the "All threads" list of a project; null goes back to Mission Control */
  showAllThreads: (projectId: string | null) => void;
  /** opens the PR tab, filtered to a project when one is given */
  showPrs: (projectId?: string | null) => void;
  showUsage: () => void;
  setLinkPrThread: (threadId: string | null) => void;
  showSettings: () => void;
  toggleSettings: () => void;
  closeSettings: () => void;
  setSettingsSection: (section: SettingsSection) => void;
  setNewProjectOpen: (open: boolean) => void;
  setNewThreadProject: (projectId: string | null) => void;
  /** opens the new-thread dialog; with only a parent, its project is used */
  openNewThread: (request: NewThreadRequest) => void;
  setProjectDialog: (dialog: ProjectDialog | null) => void;
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
      allThreadsProjectId: null,
      prsProjectId: null,
      linkPrThreadId: null,
      newExpertsProjectId: null,
      newProjectOpen: false,
      newThreadProjectId: null,
      newThreadParentId: null,
      newThreadTab: "thread",
      projectDialog: null,
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
      showAllThreads: (allThreadsProjectId) =>
        set(allThreadsProjectId === null ? { allThreadsProjectId, view: "mission" } : { allThreadsProjectId, view: "threads" }),
      showPrs: (projectId = null) => set({ view: "prs", prsProjectId: projectId }),
      showUsage: () => set({ view: "usage" }),
      setLinkPrThread: (linkPrThreadId) => set({ linkPrThreadId }),
      showSettings: () =>
        set((s) => (s.view === "settings" ? s : { view: "settings", settingsReturnTo: s.view })),
      toggleSettings: () =>
        set((s) =>
          s.view === "settings" ? { view: s.settingsReturnTo } : { view: "settings", settingsReturnTo: s.view },
        ),
      closeSettings: () => set((s) => (s.view === "settings" ? { view: s.settingsReturnTo } : s)),
      setSettingsSection: (settingsSection) => set({ settingsSection }),
      setNewProjectOpen: (newProjectOpen) => set({ newProjectOpen }),
      setNewThreadProject: (newThreadProjectId) => set({ newThreadProjectId, newThreadParentId: null, newThreadTab: "thread" }),
      openNewThread: ({ projectId, parentThreadId, tab }) => {
        const parent = parentThreadId === undefined ? undefined : useModel.getState().model.threads[parentThreadId];
        const project = projectId ?? parent?.projectId;
        if (project === undefined) return;
        set({ newThreadProjectId: project, newThreadParentId: parent ? parent.id : null, newThreadTab: tab ?? "thread" });
      },
      setProjectDialog: (projectDialog) => set({ projectDialog }),
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
      // a section saved by an older build ("remote") falls back to its successor
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<UiState>;
        const section = saved.settingsSection;
        return {
          ...current,
          ...saved,
          settingsSection:
            section === undefined ? current.settingsSection
            : (SETTINGS_SECTIONS as string[]).includes(section) ? section
            : "environments",
        };
      },
    },
  ),
);
