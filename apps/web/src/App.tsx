import { Rail } from "./components/shell/Rail.tsx";
import { StatusBar } from "./components/shell/StatusBar.tsx";
import { SplitPane } from "./components/shell/SplitPane.tsx";
import { TopBar } from "./components/shell/TopBar.tsx";
import { FocusModeSwitch } from "./components/shell/FocusModeSwitch.tsx";
import { MissionControl } from "./components/mission/MissionControl.tsx";
import { ThreadView } from "./components/thread/ThreadView.tsx";
import { Workbench } from "./components/workbench/Workbench.tsx";
import { SettingsView } from "./components/settings/SettingsView.tsx";
import { useSelectedThread } from "./state/hooks.ts";
import { useUi } from "./state/ui.ts";
import { useKeyboardMap } from "./lib/useKeyboardMap.ts";
import styles from "./App.module.css";

function Content() {
  const view = useUi((s) => s.view);
  const focusMode = useUi((s) => s.focusMode);
  const thread = useSelectedThread();

  if (view === "settings") return <SettingsView />;
  if (view !== "thread" || !thread) return <MissionControl />;
  if (focusMode === "thread") return <ThreadView thread={thread} />;
  if (focusMode === "workbench") return <Workbench />;
  return <SplitPane primary={<ThreadView thread={thread} />} secondary={<Workbench />} />;
}

export function App() {
  useKeyboardMap();
  const railCollapsed = useUi((s) => s.railCollapsed);
  return (
    <div className={styles.app}>
      <div className={styles.topRow}>
        <TopBar />
        <div className={styles.focus}>
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
    </div>
  );
}
