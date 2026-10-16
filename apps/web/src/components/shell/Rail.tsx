import { selectInbox } from "@tide/client";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { Pill } from "../ui/Pill.tsx";
import { AddProjectForm } from "./AddProjectForm.tsx";
import { NeedsYouGroup } from "./NeedsYouGroup.tsx";
import { ProjectTree } from "./ProjectTree.tsx";
import { StatusLegend } from "./StatusLegend.tsx";
import styles from "./Rail.module.css";

export function Rail() {
  const inboxCount = useModel((s) => selectInbox(s.model).length);
  const collapsed = useUi((s) => s.railCollapsed);
  const toggleRail = useUi((s) => s.toggleRail);
  const view = useUi((s) => s.view);
  const showMission = useUi((s) => s.showMission);
  const toggleSettings = useUi((s) => s.toggleSettings);
  const newProjectOpen = useUi((s) => s.newProjectOpen);
  const setNewProjectOpen = useUi((s) => s.setNewProjectOpen);

  if (collapsed) {
    return (
      <nav className={`${styles.rail} ${styles.collapsed}`} aria-label="Navigation">
        <Button variant="quiet" onClick={toggleRail} title="Expand rail (⌘B)" aria-label="Expand rail">
          ☰
        </Button>
        <Button variant="quiet" onClick={showMission} title="Mission Control (⌘0)" aria-label="Mission Control">
          ◫
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
