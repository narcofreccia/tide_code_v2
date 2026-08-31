import { selectProjects } from "@tide/client";
import { openPalette } from "../../lib/commands.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { useSelectedThread } from "../../state/hooks.ts";
import { ThreadPills } from "../thread/ThreadPills.tsx";
import { Button } from "../ui/Button.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { Select, type SelectOption } from "../ui/Select.tsx";
import { ThreadTitle } from "./ThreadTitle.tsx";
import styles from "./TopBar.module.css";

export function TopBar() {
  const model = useModel((s) => s.model);
  const projects = selectProjects(model);
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const selectProject = useUi((s) => s.selectProject);
  const showMission = useUi((s) => s.showMission);
  const thread = useSelectedThread();

  const projectOptions: SelectOption<string>[] = [
    { value: "", label: "All projects" },
    ...projects.map((p) => ({ value: p.id, label: p.title, description: p.rootPath })),
  ];

  return (
    // Tauri v2 drags from this attribute (not `-webkit-app-region`), and only when
    // the event target *is* the element carrying it — so children stay clickable.
    <header className={styles.bar} data-tauri-drag-region>
      <Button className={styles.palette} title="Command palette" aria-label="Command palette" onClick={openPalette}>
        <Kbd>⌘K</Kbd>
      </Button>

      <Select
        className={styles.switcher}
        label="Project switcher"
        align="start"
        value={selectedProjectId ?? ""}
        options={projectOptions}
        onSelect={(id) => {
          selectProject(id || null);
          showMission();
        }}
      />

      {thread ? <ThreadTitle thread={thread} /> : <span className={styles.idle}>Mission Control</span>}

      <div className={styles.pills} data-tauri-drag-region>
        {thread ? <ThreadPills thread={thread} /> : null}
      </div>
    </header>
  );
}
