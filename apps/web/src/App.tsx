import { Rail } from "./components/shell/Rail.tsx";
import { StatusBar } from "./components/shell/StatusBar.tsx";
import { SplitPane } from "./components/shell/SplitPane.tsx";
import { TopBar } from "./components/shell/TopBar.tsx";
import { FocusModeSwitch } from "./components/shell/FocusModeSwitch.tsx";
import { ThemeToggle } from "./components/shell/ThemeToggle.tsx";
import { MissionControl } from "./components/mission/MissionControl.tsx";
import { AllThreads } from "./components/mission/AllThreads.tsx";
import { ThreadView } from "./components/thread/ThreadView.tsx";
import { ExpertsView } from "./components/experts/ExpertsView.tsx";
import { CreateExpertsDialog } from "./components/experts/CreateExpertsDialog.tsx";
import { Workbench } from "./components/workbench/Workbench.tsx";
import { SettingsView } from "./components/settings/SettingsView.tsx";
import { PrsView } from "./components/prs/PrsView.tsx";
import { LinkPrDialogHost } from "./components/prs/LinkPrDialog.tsx";
import { UsageView } from "./components/usage/UsageView.tsx";
import { useSelectedThread } from "./state/hooks.ts";
import { useUi } from "./state/ui.ts";
import { ToastHost } from "./components/ui/Toast.tsx";
import { QuickOpen } from "./components/shell/QuickOpen.tsx";
import { NewThreadDialogHost } from "./components/shell/NewThreadPopover.tsx";
import { CommandPaletteHost } from "./components/shell/CommandPalette.tsx";
import { ThreadDialogHost } from "./components/thread/ThreadDialogs.tsx";
import { ProjectDialogHost } from "./components/shell/ProjectDialogs.tsx";
import { ProjectLinksDialogHost } from "./components/mission/ProjectLinks.tsx";
import { useWorkbench } from "./state/workbench.ts";
import { useKeyboardMap } from "./lib/useKeyboardMap.ts";
import { useHashRoute } from "./lib/useHashRoute.ts";
import { useMergeOutcomeToasts } from "./lib/mergeToasts.ts";
import { useDocumentTitle } from "./lib/useDocumentTitle.ts";
import { useNotificationEvents } from "./lib/useNotificationEvents.ts";
import { useViewport } from "./lib/useViewport.ts";
import { InboxScreen } from "./components/mobile/InboxScreen.tsx";
import { PhoneEffects } from "./components/mobile/PhoneEffects.tsx";
import { TabBar } from "./components/mobile/TabBar.tsx";
import { ThreadSheet } from "./components/mobile/ThreadSheet.tsx";
import { useMobileNav } from "./components/mobile/mobileNav.ts";
import styles from "./App.module.css";

function Content() {
  const view = useUi((s) => s.view);
  const focusMode = useUi((s) => s.focusMode);
  const expertsSessionId = useUi((s) => s.selectedExpertsSessionId);
  const allThreadsProjectId = useUi((s) => s.allThreadsProjectId);
  const thread = useSelectedThread();
  const { phone } = useViewport();
  const inboxOpen = useMobileNav((s) => s.inboxOpen);
  const codeOpen = useMobileNav((s) => s.codeOpen);

  if (view === "settings") return <SettingsView />;
  if (view === "prs") return <PrsView />;
  if (view === "usage") return <UsageView />;
  if (view === "threads" && allThreadsProjectId) return <AllThreads projectId={allThreadsProjectId} />;
  if (view === "experts" && expertsSessionId) {
    const board = <ExpertsView sessionId={expertsSessionId} />;
    if (phone) return codeOpen && thread ? <Workbench /> : board;
    if (focusMode === "thread" || !thread) return board;
    if (focusMode === "workbench") return <Workbench />;
    return <SplitPane primary={board} secondary={<Workbench />} />;
  }
  if (view !== "thread" || !thread) return phone && inboxOpen ? <InboxScreen /> : <MissionControl />;
  if (phone) return codeOpen ? <Workbench /> : <ThreadView thread={thread} />;
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
  useHashRoute();
  useMergeOutcomeToasts();
  useDocumentTitle();
  useNotificationEvents();
  const railCollapsed = useUi((s) => s.railCollapsed);
  const { phone } = useViewport();
  // the tab bar stays out of the way of a conversation: threads and boards have a back button instead
  // PRs and Usage are reached from the palette on a phone; they are lists, so the tabs stay
  const tabs = useUi(
    (s) => s.view === "mission" || s.view === "settings" || s.view === "threads" || s.view === "prs" || s.view === "usage",
  );
  return (
    <div className={`${styles.app} ${phone ? styles.phone : ""}`}>
      <div className={styles.topRow}>
        <TopBar />
        {phone ? null : (
          <div className={styles.focus} data-tauri-drag-region>
            <ThemeToggle />
            <FocusModeSwitch />
          </div>
        )}
      </div>
      <main className={`${styles.body} ${railCollapsed ? styles.railCollapsed : ""}`}>
        {phone ? null : <Rail />}
        <div className={styles.content}>
          <Content />
        </div>
      </main>
      {phone ? tabs ? <TabBar /> : null : <StatusBar />}
      {phone ? <PhoneEffects /> : null}
      {phone ? <ThreadSheet /> : null}
      <ToastHost />
      <QuickOpenHost />
      <CommandPaletteHost />
      <ThreadDialogHost />
      <ProjectDialogHost />
      <ExpertsDialogHost />
      <ProjectLinksDialogHost />
      <NewThreadDialogHost />
      <LinkPrDialogHost />
    </div>
  );
}
