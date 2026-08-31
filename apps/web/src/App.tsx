import { Rail } from "./components/shell/Rail.tsx";
import { StatusBar } from "./components/shell/StatusBar.tsx";
import { SplitPane } from "./components/shell/SplitPane.tsx";
import { TopBar } from "./components/shell/TopBar.tsx";
import { FocusModeSwitch } from "./components/shell/FocusModeSwitch.tsx";
import { ThemeToggle } from "./components/shell/ThemeToggle.tsx";
import { MissionControl } from "./components/mission/MissionControl.tsx";
import { ThreadView } from "./components/thread/ThreadView.tsx";
import { ExpertsView } from "./components/experts/ExpertsView.tsx";
import { CreateExpertsDialog } from "./components/experts/CreateExpertsDialog.tsx";
import { Workbench } from "./components/workbench/Workbench.tsx";
import { SettingsView } from "./components/settings/SettingsView.tsx";
import { useSelectedThread } from "./state/hooks.ts";
import { useUi } from "./state/ui.ts";
import { ToastHost } from "./components/ui/Toast.tsx";
import { QuickOpen } from "./components/shell/QuickOpen.tsx";
import { CommandPaletteHost } from "./components/shell/CommandPalette.tsx";
import { ThreadDialogHost } from "./components/thread/ThreadDialogs.tsx";
import { useWorkbench } from "./state/workbench.ts";
import { useKeyboardMap } from "./lib/useKeyboardMap.ts";
import styles from "./App.module.css";

function Content() {
  const view = useUi((s) => s.view);
  const focusMode = useUi((s) => s.focusMode);
  const expertsSessionId = useUi((s) => s.selectedExpertsSessionId);
  const thread = useSelectedThread();

  if (view === "settings") return <SettingsView />;
  if (view === "experts" && expertsSessionId) {
    const board = <ExpertsView sessionId={expertsSessionId} />;
    if (focusMode === "thread" || !thread) return board;
    if (focusMode === "workbench") return <Workbench />;
    return <SplitPane primary={board} secondary={<Workbench />} />;
  }
  if (view !== "thread" || !thread) return <MissionControl />;
  if (focusMode === "thread") return <ThreadView thread={thread} />;
  if (focusMode === "workbench") return <Workbench />;
  return <SplitPane primary={<ThreadView thread={thread} />} secondary={<Workbench />} />;
}

function ExpertsDialogHost() {
  const projectId = useUi((s) => s.newExpertsProjectId);
  const setNewExpertsProject = useUi((s) => s.setNewExpertsProject);
  if (projectId === null) return null;
  return <CreateExpertsDialog projectId={projectId} onClose={() => setNewExpertsProject(null)} />;
}

function QuickOpenHost() {
  const open = useWorkbench((s) => s.quickOpen);
  const thread = useSelectedThread();
  if (!open || !thread) return null;
  return <QuickOpen threadId={thread.id} />;
}

export function App() {
  useKeyboardMap();
  const railCollapsed = useUi((s) => s.railCollapsed);
  return (
    <div className={styles.app}>
      <div className={styles.topRow}>
        <TopBar />
        <div className={styles.focus} data-tauri-drag-region>
          <ThemeToggle />
          <FocusModeSwitch />
        </div>
      </div>
      <main className={`${styles.body} ${railCollapsed ? styles.railCollapsed : ""}`}>
        <Rail />
        <div className={styles.content}>
          <Content />
        </div>
      </main>
      <StatusBar />
      <ToastHost />
      <QuickOpenHost />
      <CommandPaletteHost />
      <ThreadDialogHost />
      <ExpertsDialogHost />
    </div>
  );
}
