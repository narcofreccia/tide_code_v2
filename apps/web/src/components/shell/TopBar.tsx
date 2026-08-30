import { selectProjects } from "@tide/client";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { useSelectedThread } from "../../state/hooks.ts";
import { ThreadPills } from "../thread/ThreadPills.tsx";
import { Button } from "../ui/Button.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { ThreadTitle } from "./ThreadTitle.tsx";
import styles from "./TopBar.module.css";

export function TopBar() {
  const model = useModel((s) => s.model);
  const projects = selectProjects(model);
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const selectProject = useUi((s) => s.selectProject);
  const showMission = useUi((s) => s.showMission);
  const thread = useSelectedThread();

  return (
    <header className={styles.bar}>
      <Button className={styles.palette} disabled title="Command palette (coming soon)">
        <Kbd>⌘K</Kbd>
      </Button>

      <select
        className={styles.switcher}
        aria-label="Project switcher"
        value={selectedProjectId ?? ""}
        onChange={(e) => {
          selectProject(e.target.value || null);
          showMission();
        }}
      >
        <option value="">All projects</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title}
          </option>
        ))}
      </select>

      {thread ? <ThreadTitle thread={thread} /> : <span className={styles.idle}>Mission Control</span>}

      <div className={styles.pills}>{thread ? <ThreadPills thread={thread} /> : null}</div>
    </header>
  );
}
