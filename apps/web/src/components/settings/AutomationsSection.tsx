import { useState } from "react";
import { selectProjects, selectScheduledTasks, selectThreadsByProject } from "@tide/client";
import type { ScheduledTask } from "@tide/contracts";
import { dispatchOrToast, runOrToast } from "../../lib/dispatchOrToast.ts";
import { relativeTime, relativeUntil } from "../../lib/relativeTime.ts";
import { describeSchedule, formatOnce } from "../../lib/schedule.ts";
import { createTask, deleteTask, runTaskNow, updateTask, type TaskFields } from "../../lib/taskActions.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { useProjectDeviceLimit } from "../../state/deviceAccess.ts";
import { Button } from "../ui/Button.tsx";
import { ConfirmDialog } from "../ui/Dialog.tsx";
import { TaskDialog } from "./TaskDialog.tsx";
import { WebhookUrls } from "../fleet/WebhookUrls.tsx";
import { plural } from "../../lib/format.ts";
import type { SectionMeta } from "./search.ts";
import { SettingNote, SettingsGroup } from "./ui/SettingsGroup.tsx";
import { SettingsPage } from "./ui/SettingsPage.tsx";
import { SettingRow } from "./ui/SettingRow.tsx";
import { SettingToggle } from "./ui/SettingToggle.tsx";
import styles from "./Rows.module.css";

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
  const title = task.threadId === undefined ? undefined : (model.threads[task.threadId]?.title ?? "thread (gone)");
  const target =
    task.threadId === undefined
      ? `new thread on ${task.provider ?? "default harness"}`
      : task.threadMode === "fresh_session"
        ? `fresh session in ${title}`
        : `continues ${title}`;
  // a one-time task that ran disabled itself; a new time arms it again (enabled) even though completedAt stays
  const done = task.completedAt !== undefined && !task.enabled;
  const last = task.lastRunAt === undefined ? "never run" : `last ${relativeTime(task.lastRunAt)} ago`;
  // R19: creating, editing and deleting automations needs Full access on that machine
  const limit = useProjectDeviceLimit(task.projectId);
  const off = { disabled: limit !== undefined, title: limit };
  return (
    <SettingRow
      id={`setting-task-${task.id}`}
      label={<span className={styles.name}>{task.title}</span>}
      help={
        <span className={styles.meta}>
          <span>{describeSchedule(task.schedule)}</span>
          <span>{target}</span>
          <span>{done ? `Done · ${formatOnce(task.completedAt as number)}` : task.enabled ? (task.nextRunAt === undefined ? "no next run" : `next ${relativeUntil(task.nextRunAt)}`) : "paused"}</span>
          {task.lastRunThreadId !== undefined ? (
            <Button variant="link" onClick={() => selectThread(task.lastRunThreadId ?? null)}>{last}</Button>
          ) : (
            <span>{last}</span>
          )}
          <span>{plural(task.runs, "run")}</span>
        </span>
      }
      control={
        <>
          <Button {...off} onClick={() => runOrToast("Running the automation", () => runTaskNow(task.id))}>Run now</Button>
          <Button {...off} onClick={onEdit}>Edit</Button>
          <Button variant="quietDanger" {...off} onClick={onDelete}>Delete</Button>
          <SettingToggle
            label={`Enable ${task.title}`}
            checked={task.enabled}
            disabled={done || limit !== undefined}
            onChange={(enabled) => dispatchOrToast("Updating the automation", { type: "task.update", taskId: task.id, enabled })}
          />
        </>
      }
      extra={task.schedule.kind === "webhook" ? <WebhookUrls hookId={task.schedule.hookId} projectId={task.projectId} compact /> : undefined}
    />
  );
}

export const META: SectionMeta = {
  title: "Automations",
  blurb:
    "Send a prompt on a schedule, into a thread or as a new one. The server must be running at the time; missed fixed times are skipped.",
  keywords: ["New automation", "schedule", "webhook", "cron", "interval"],
};

/** Empty-state wording that matches the scope the top bar's switcher set. */
function emptyText(scoped: boolean, grouped: boolean, title: string): string {
  if (scoped) return "No automations for this project.";
  if (grouped) return "No automations.";
  return `No automations in ${title} yet.`;
}

function NewAutomation({ projectId, quiet, onNew }: { projectId: string; quiet: boolean; onNew: () => void }) {
  const limit = useProjectDeviceLimit(projectId);
  return (
    <Button variant={quiet ? "ghost" : "primary"} disabled={limit !== undefined} title={limit} onClick={onNew}>
      New automation
    </Button>
  );
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
    <SettingsPage title={META.title} blurb={META.blurb}>
      {projects.length === 0 ? (
        <SettingsGroup title="Automations">
          <SettingNote>No projects yet.</SettingNote>
        </SettingsGroup>
      ) : null}
      {projects.map((project) => {
        const tasks = selectScheduledTasks(model, project.id);
        return (
          <SettingsGroup
            key={project.id}
            title={grouped ? project.title : "Scheduled prompts"}
            label={`Automations for ${project.title}`}
            actions={<NewAutomation projectId={project.id} quiet={grouped} onNew={() => setEditing({ projectId: project.id })} />}
          >
            {tasks.length === 0 ? (
              <SettingNote>{emptyText(selectedProjectId !== null, grouped, project.title)}</SettingNote>
            ) : (
              tasks.map((task) => (
                <TaskRow key={task.id} task={task} onEdit={() => setEditing({ task, projectId: project.id })} onDelete={() => setDeleting(task)} />
              ))
            )}
          </SettingsGroup>
        );
      })}
      {editing ? (
        <TaskDialog
          {...(editing.task ? { task: editing.task } : {})}
          threads={selectThreadsByProject(model, editing.projectId)}
          projectId={editing.projectId}
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
    </SettingsPage>
  );
}
