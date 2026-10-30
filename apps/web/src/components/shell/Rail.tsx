import { selectInbox, selectOpenPrCount } from "@tide/client";
import { usePrs } from "../prs/prData.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { Pill } from "../ui/Pill.tsx";
import { AddProjectForm } from "./AddProjectForm.tsx";
import { NeedsYouGroup } from "./NeedsYouGroup.tsx";
import { ProjectTree } from "./ProjectTree.tsx";
import { RailSelectionBar } from "./RailSelectionBar.tsx";
import { useInboxKeys } from "./useInboxKeys.ts";
import { useMarkSeen } from "./useMarkSeen.ts";
import { StatusLegend } from "./StatusLegend.tsx";
import styles from "./Rail.module.css";

/** Open PRs: the PR tab's list once it has loaded, else the thread-linked ones the read model knows. */
function useOpenPrCount(): number {
  const listed = usePrs((s) => (s.fetchedAt === undefined ? undefined : s.items.filter((i) => i.pr.state === "open").length));
  const known = useModel((s) => selectOpenPrCount(s.model));
  return listed ?? known;
}

/** The two R10 pages under Mission Control: "Pull requests · n open" and "Usage". */
function RailPages({ view }: { view: string }) {
  const open = useOpenPrCount();
  const showPrs = useUi((s) => s.showPrs);
  const showUsage = useUi((s) => s.showUsage);
  return (
    <div className={styles.pages}>
      <Button
        variant="quiet"
        className={`${styles.page} ${view === "prs" ? styles.activePage : ""}`}
        aria-current={view === "prs" ? "page" : undefined}
        onClick={() => showPrs(null)}
      >
        Pull requests{open > 0 ? ` · ${open} open` : ""}
      </Button>
      <Button
        variant="quiet"
        className={`${styles.page} ${view === "usage" ? styles.activePage : ""}`}
        aria-current={view === "usage" ? "page" : undefined}
        onClick={() => showUsage()}
      >
        Usage
      </Button>
    </div>
  );
}

export function Rail() {
  const inboxCount = useModel((s) => selectInbox(s.model).length);
  const collapsed = useUi((s) => s.railCollapsed);
  const toggleRail = useUi((s) => s.toggleRail);
  const view = useUi((s) => s.view);
  const showMission = useUi((s) => s.showMission);
  const toggleSettings = useUi((s) => s.toggleSettings);
  const newProjectOpen = useUi((s) => s.newProjectOpen);
  const setNewProjectOpen = useUi((s) => s.setNewProjectOpen);
  useInboxKeys();
  useMarkSeen();

  if (collapsed) {
    return (
      <nav className={`${styles.rail} ${styles.collapsed}`} aria-label="Navigation">
        <Button variant="quiet" onClick={toggleRail} title="Expand rail (⌘B)" aria-label="Expand rail">
          ☰
        </Button>
        <Button variant="quiet" onClick={showMission} title="Mission Control (⌘0)" aria-label="Mission Control">
          ◫
        </Button>
        <Button variant="quiet" onClick={() => useUi.getState().showPrs(null)} title="Pull requests" aria-label="Pull requests">
          ⇡
        </Button>
        <Button variant="quiet" onClick={() => useUi.getState().showUsage()} title="Usage" aria-label="Usage">
          ▥
        </Button>
        {inboxCount > 0 ? <Pill tone="needs">{inboxCount}</Pill> : null}
        <Button variant="quiet" onClick={toggleSettings} title="Settings" aria-label="Settings">
          ⚙
        </Button>
      </nav>
    );
  }

  return (
    <nav className={styles.rail} aria-label="Navigation">
      <div className={styles.head}>
        <Button variant="quiet" onClick={toggleRail} title="Collapse rail" aria-label="Collapse rail">
          ☰
        </Button>
        <Button variant="quiet" onClick={showMission} className={styles.mission} title="Mission Control (⌘0)">
          Mission Control
        </Button>
      </div>
      <RailPages view={view} />

      <RailSelectionBar />
      <NeedsYouGroup />

      <div className={styles.section}>
        <span className={styles.heading}>Projects</span>
        <Button variant="quiet" onClick={() => setNewProjectOpen(!newProjectOpen)} title="Add a repository">
          + project
        </Button>
      </div>
      {newProjectOpen ? <AddProjectForm onDone={() => setNewProjectOpen(false)} /> : null}

      <div className={styles.scroll}>
        <ProjectTree />
      </div>

      <div className={styles.foot}>
        <Button
          variant="quiet"
          onClick={toggleSettings}
          className={view === "settings" ? styles.activeFoot : undefined}
        >
          ⚙ Settings
        </Button>
        <StatusLegend />
        <Kbd>⌘B</Kbd>
      </div>
    </nav>
  );
}
