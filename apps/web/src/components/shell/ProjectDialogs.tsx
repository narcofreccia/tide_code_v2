import { useState } from "react";
import type { Project } from "@tide/contracts";
import { archiveProject, renameProject } from "../../lib/projectActions.ts";
import { detectProjectIcon, setProjectIcon } from "../../lib/projectIcon.ts";
import { Button } from "../ui/Button.tsx";
import { ProjectIcon, firstGrapheme } from "../ui/ProjectIcon.tsx";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { ConfirmDialog, Dialog, PromptDialog } from "../ui/Dialog.tsx";
import styles from "./ProjectIconDialog.module.css";

/** Detect a favicon from the repo, type an emoji, or clear back to the first letter. */
export function ProjectIconDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [emoji, setEmoji] = useState("");
  const [busy, setBusy] = useState(false);
  const [missed, setMissed] = useState(false);
  const glyph = firstGrapheme(emoji);
  return (
    <Dialog title="Project icon" onCancel={onClose}>
      <div className={styles.current}>
        <ProjectIcon project={project} />
        <span>{project.title}</span>
      </div>
      <div className={styles.block}>
        <Button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setMissed(false);
            void detectProjectIcon(project.id).then((found) => {
              setBusy(false);
              if (found) onClose();
              else setMissed(true);
            });
          }}
        >
          Detect from repo
        </Button>
        {missed ? <span className={styles.hint}>No favicon found in the project folder.</span> : null}
      </div>
      <label className={styles.block}>
        <span className={styles.label}>Emoji</span>
        <input
          className={styles.input}
          aria-label="Emoji"
          value={emoji}
          placeholder="🚀"
          onChange={(e) => setEmoji(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || glyph === "") return;
            e.preventDefault();
            setProjectIcon(project.id, { kind: "emoji", value: glyph });
            onClose();
          }}
        />
      </label>
      <div className={styles.actions}>
        <Button
          variant="quietDanger"
          disabled={project.icon === undefined}
          onClick={() => {
            setProjectIcon(project.id, null);
            onClose();
          }}
        >
          Clear
        </Button>
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={glyph === ""}
          onClick={() => {
            setProjectIcon(project.id, { kind: "emoji", value: glyph });
            onClose();
          }}
        >
          Use emoji
        </Button>
      </div>
    </Dialog>
  );
}

/**
 * Rename / archive for a project, raised from the rail's context menu through
 * `ui.projectDialog`. Mission Control's project card keeps its own copies for now.
 */
export function ProjectDialogHost() {
  const dialog = useUi((s) => s.projectDialog);
  const setProjectDialog = useUi((s) => s.setProjectDialog);
  const project = useModel((s) => (dialog ? s.model.projects[dialog.projectId] : undefined));
  if (!dialog || !project) return null;
  const close = (): void => setProjectDialog(null);
  if (dialog.kind === "icon") return <ProjectIconDialog project={project} onClose={close} />;
  if (dialog.kind === "rename") {
    return (
      <PromptDialog
        title="Rename project"
        label="Project name"
        initial={project.title}
        confirmLabel="Rename"
        onCancel={close}
        onSubmit={(title) => {
          close();
          if (title !== project.title) renameProject(project.id, title);
        }}
      />
    );
  }
  return (
    <ConfirmDialog
      title="Archive project"
      body={
        <>
          Archive <strong>{project.title}</strong>? It leaves Mission Control and the rail. Its threads, worktrees and
          branches are left as they are.
        </>
      }
      confirmLabel="Archive"
      onCancel={close}
      onConfirm={() => {
        close();
        archiveProject(project.id);
      }}
    />
  );
}
