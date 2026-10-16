import { selectScheduledTasks } from "@tide/client";
import { relativeUntil } from "../../lib/relativeTime.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import styles from "./MissionControl.module.css";
import { plural } from "../../lib/format.ts";

/** "2 automations · next in 5m" on the project card; hidden when the project has none. */
export function ProjectAutomations({ projectId }: { projectId: string }) {
  const model = useModel((s) => s.model);
  const tasks = selectScheduledTasks(model, projectId);
  if (tasks.length === 0) return null;
  const next = tasks.filter((t) => t.enabled && t.nextRunAt !== undefined).map((t) => t.nextRunAt as number);
  const soonest = next.length === 0 ? undefined : Math.min(...next);
  const open = (): void => {
    const ui = useUi.getState();
    ui.selectProject(projectId);
    ui.setSettingsSection("automations");
    ui.showSettings();
  };
  return (
    <div className={styles.costRow}>
      <Button variant="link" onClick={open} title="Open Settings › Automations">
        {plural(tasks.length, "automation")}
        {soonest === undefined ? " · paused" : ` · next ${relativeUntil(soonest)}`}
      </Button>
    </div>
  );
}
