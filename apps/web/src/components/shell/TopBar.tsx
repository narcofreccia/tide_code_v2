import { selectProjects } from "@tide/client";
import { openPalette } from "../../lib/commands.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { useViewHeading } from "../../state/hooks.ts";
import { Button } from "../ui/Button.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { Select, type SelectOption } from "../ui/Select.tsx";
import { useViewport } from "../../lib/useViewport.ts";
import { PhoneTopBar } from "../mobile/PhoneTopBar.tsx";
import { Logo } from "./Logo.tsx";
import styles from "./TopBar.module.css";

export function TopBar() {
  const model = useModel((s) => s.model);
  const projects = selectProjects(model);
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const selectProject = useUi((s) => s.selectProject);
  const showMission = useUi((s) => s.showMission);
  const selectThread = useUi((s) => s.selectThread);
  const heading = useViewHeading();
  const { phone } = useViewport();

  const projectOptions: SelectOption<string>[] = [
    { value: "", label: "All projects" },
    ...projects.map((p) => ({ value: p.id, label: p.title, description: p.rootPath })),
  ];

  if (phone) return <PhoneTopBar />;

  return (
    // Tauri v2 drags from this attribute (not `-webkit-app-region`), and only when
    // the event target *is* the element carrying it — so children stay clickable.
    <header className={styles.bar} data-tauri-drag-region>
      <Button
        variant="quiet"
        className={styles.logo}
        title="Mission Control (⌘0)"
        aria-label="Tide — Mission Control"
        onClick={() => {
          selectThread(null);
          showMission();
        }}
      >
        <Logo size={18} />
      </Button>

      <Button className={styles.palette} title="Command palette" aria-label="Command palette" onClick={openPalette}>
        <Kbd>⌘K</Kbd>
      </Button>

      {heading.kind === "thread" ? null : (
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
      )}

      {heading.kind === "thread" ? (
        <nav className={styles.crumb} aria-label="Breadcrumb">
          <span className={styles.crumbProject}>{heading.projectTitle}</span>
          <span aria-hidden="true">›</span>
          <span className={styles.crumbThread}>{heading.thread.title}</span>
        </nav>
      ) : (
        <span className={styles.idle}>{heading.label}</span>
      )}

    </header>
  );
}
