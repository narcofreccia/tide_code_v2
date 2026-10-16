import { useState } from "react";
import { selectProjects, selectScheduledTasks, selectThreadsByProject } from "@tide/client";
import type { ScheduledTask } from "@tide/contracts";
import { dispatchOrToast, runOrToast } from "../../lib/dispatchOrToast.ts";
import { relativeTime, relativeUntil } from "../../lib/relativeTime.ts";
import { describeSchedule } from "../../lib/schedule.ts";
import { createTask, deleteTask, runTaskNow, updateTask, type TaskFields } from "../../lib/taskActions.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Choice.tsx";
import { ConfirmDialog } from "../ui/Dialog.tsx";
import { TaskDialog } from "./TaskDialog.tsx";
import styles from "./Automations.module.css";
import section from "./Section.module.css";
import { plural } from "../../lib/format.ts";

type Editing = { task?: ScheduledTask; projectId: string } | null;

function TaskRow({
  task,
  onEdit,
  onDelete,
}: {
  task: ScheduledTask;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const model = useModel((s) => s.model);
  const selectThread = useUi((s) => s.selectThread);
  const target = task.threadId === undefined ? `new thread on ${task.provider ?? "default harness"}` : (model.threads[task.threadId]?.title ?? "thread (gone)");
  const last = task.lastRunAt === undefined ? "never run" : `last ${relativeTime(task.lastRunAt)} ago`;
  return (
    <li className={`${section.row} ${styles.item}`}>
      <div className={styles.top}>
        <span className={styles.name}>{task.title}</span>
        <Checkbox
          aria-label={`Enable ${task.title}`}
          checked={task.enabled}
          onChange={(e) => dispatchOrToast("Updating the automation", { type: "task.update", taskId: task.id, enabled: e.target.checked })}
        />
        <div className={styles.actions}>
          <Button onClick={() => runOrToast("Running the automation", () => runTaskNow(task.id))}>Run now</Button>
          <Button onClick={onEdit}>Edit</Button>
          <Button variant="quiet" onClick={onDelete}>Delete</Button>
        </div>
      </div>
      <div className={styles.meta}>
        <span>{describeSchedule(task.schedule)}</span>
        <span>{target}</span>
        <span>{task.enabled ? (task.nextRunAt === undefined ? "no next run" : `next ${relativeUntil(task.nextRunAt)}`) : "paused"}</span>
        {task.lastRunThreadId !== undefined ? (
          <Button variant="link" onClick={() => selectThread(task.lastRunThreadId ?? null)}>{last}</Button>
        ) : (
          <span>{last}</span>
        )}
        <span>{plural(task.runs, "run")}</span>
      </div>
    </li>
  );
}

/** Empty-state wording that matches the scope the top bar's switcher set. */
function emptyText(scoped: boolean, grouped: boolean, title: string): string {
  if (scoped) return "No automations for this project.";
  if (grouped) return "No automations.";
  return `No automations in ${title} yet.`;
}

/** Settings › Automations: scheduled prompts for the selected project (or every project). */
export function AutomationsSection() {
  const model = useModel((s) => s.model);
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<ScheduledTask | null>(null);
  const projects = selectProjects(model).filter((p) => selectedProjectId === null || p.id === selectedProjectId);
  const grouped = selectedProjectId === null && projects.length > 1;

  const save = (fields: TaskFields): void => {
    if (!editing) return;
    const { task, projectId } = editing;
    setEditing(null);
    runOrToast("Saving the automation", () => (task ? updateTask(task.id, fields) : createTask(projectId, fields)));
  };

  return (
    <div className={section.section}>
      <div className={section.head}>
        <h3 className={section.title}>Automations</h3>
        {projects.length === 1 ? (
          <Button variant="primary" onClick={() => setEditing({ projectId: projects[0]?.id ?? "" })}>New automation</Button>
        ) : null}
      </div>
      <p className={section.note}>
        Send a prompt on a schedule, into a thread or as a new one. The server must be running at the time; missed fixed times are skipped.
      </p>
      {projects.length === 0 ? <p className={section.note}>No projects yet.</p> : null}
      {projects.map((project) => {
        const tasks = selectScheduledTasks(model, project.id);
        return (
          <div key={project.id} className={styles.group} aria-label={`Automations for ${project.title}`}>
            {grouped ? (
              <div className={section.head}>
                <h4 className={styles.groupTitle}>{project.title}</h4>
                <Button variant="link" onClick={() => setEditing({ projectId: project.id })}>New automation</Button>
              </div>
            ) : null}
            {tasks.length === 0 ? (
              <p className={section.note}>{emptyText(selectedProjectId !== null, grouped, project.title)}</p>
            ) : (
              <ul className={section.rows}>
                {tasks.map((task) => (
                  <TaskRow key={task.id} task={task} onEdit={() => setEditing({ task, projectId: project.id })} onDelete={() => setDeleting(task)} />
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {editing ? (
        <TaskDialog
          {...(editing.task ? { task: editing.task } : {})}
          threads={selectThreadsByProject(model, editing.projectId)}
          onSubmit={save}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title="Delete automation"
          body={<>Delete <strong>{deleting.title}</strong>? Threads it already created are kept.</>}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const id = deleting.id;
            setDeleting(null);
            runOrToast("Deleting the automation", () => deleteTask(id));
          }}
        />
      ) : null}
    </div>
  );
}
