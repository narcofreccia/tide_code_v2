import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import styles from "./Board.module.css";

/** The project an Experts session would start in: the one in view, else the open thread's, else the first live one. */
function useTargetProject(given: string | undefined): string | undefined {
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const selectedThreadId = useUi((s) => s.selectedThreadId);
  const model = useModel((s) => s.model);
  if (given !== undefined) return given;
  if (selectedProjectId !== null) return selectedProjectId;
  const fromThread = selectedThreadId ? model.threads[selectedThreadId]?.projectId : undefined;
  return fromThread ?? Object.values(model.projects).find((p) => p.archivedAt === undefined)?.id;
}

/** What Experts is, with the one action that starts a session. Shown where there is no board to show. */
export function ExpertsEmpty({ projectId, note }: { projectId?: string; note?: string }) {
  const target = useTargetProject(projectId);
  const setNewExpertsProject = useUi((s) => s.setNewExpertsProject);
  return (
    <div className={styles.emptyState} aria-label="About Experts">
      <span className={styles.emptyIcon}>
        <Icon name="experts" size={20} />
      </span>
      <h2 className={styles.emptyTitle}>Experts</h2>
      {note ? <p className={styles.emptyNote}>{note}</p> : null}
      <p className={styles.emptyText}>Several agents explore a question, discuss, and propose one plan.</p>
      <Button
        variant="primary"
        disabled={target === undefined}
        title={target === undefined ? "Add a project first" : undefined}
        onClick={() => {
          if (target !== undefined) setNewExpertsProject(target);
        }}
      >
        Start an Experts session
      </Button>
    </div>
  );
}
