import { useState } from "react";
import { selectProjectLinks } from "@tide/client";
import type { ProjectLink } from "@tide/contracts";
import { addProjectLink, removeProjectLink, updateProjectLink, type LinkDraft } from "../../lib/linkActions.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { ConfirmDialog, Dialog } from "../ui/Dialog.tsx";
import { Pill } from "../ui/Pill.tsx";
import { emptyDraft, LinkEditor } from "./LinkEditor.tsx";
import styles from "./ProjectLinks.module.css";

export const LINKS_EXPLAINER =
  "Threads in this project can read (and optionally edit) these repositories. The agent is told what each one is.";

/** `rw` / `ro` — the same shorthand the thread chips use. */
export function accessLabel(access: ProjectLink["access"]): string {
  return access === "write" ? "rw" : "ro";
}

function toDraft(link: ProjectLink): LinkDraft {
  return { path: link.path, label: link.label, note: link.note ?? "", access: link.access };
}

function LinkRow({ projectId, link }: { projectId: string; link: ProjectLink }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (editing) {
    return (
      <li className={styles.item}>
        <LinkEditor
          mode="edit"
          initial={toDraft(link)}
          onCancel={() => setEditing(false)}
          onSubmit={(draft) => {
            void updateProjectLink(projectId, link.id, {
              label: draft.label,
              note: draft.note,
              access: draft.access,
            })
              .then(() => setEditing(false))
              .catch(() => undefined);
          }}
        />
      </li>
    );
  }

  return (
    <li className={styles.item}>
      <div className={styles.head}>
        <span className={styles.label}>{link.label}</span>
        <Pill tone={link.access === "write" ? "accent" : "muted"}>{accessLabel(link.access)}</Pill>
        <span className={styles.path} title={link.path}>
          {link.path}
        </span>
        <span className={styles.rowActions}>
          <Button variant="quiet" onClick={() => setEditing(true)} aria-label={`Edit ${link.label}`}>
            Edit
          </Button>
          <Button variant="quiet" onClick={() => setConfirming(true)} aria-label={`Remove ${link.label}`}>
            Remove
          </Button>
        </span>
      </div>
      {link.note ? <p className={styles.note}>{link.note}</p> : null}
      {confirming ? (
        <ConfirmDialog
          title={`Unlink “${link.label}”?`}
          confirmLabel="Remove link"
          body={
            <span>
              New threads stop reaching <span className={styles.mono}>{link.path}</span>. Nothing on disk changes.
            </span>
          }
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            removeProjectLink(projectId, link.id);
            setConfirming(false);
          }}
        />
      ) : null}
    </li>
  );
}

/** Project settings › Linked repositories: the list, plus add / edit / remove. */
export function ProjectLinks({ projectId }: { projectId: string }) {
  const links = selectProjectLinks(useModel((s) => s.model), projectId);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <section className={styles.section} aria-label="Linked repositories">
      <div className={styles.sectionHead}>
        <h3 className={styles.heading}>Linked repositories</h3>
        {adding ? null : <Button onClick={() => setAdding(true)}>Add repository…</Button>}
      </div>
      <p className={styles.explainer}>{LINKS_EXPLAINER}</p>

      {links.length === 0 && !adding ? (
        <p className={styles.empty}>No linked repositories yet.</p>
      ) : (
        <ul className={styles.list}>
          {links.map((link) => (
            <LinkRow key={link.id} projectId={projectId} link={link} />
          ))}
        </ul>
      )}

      {adding ? (
        <LinkEditor
          mode="add"
          initial={emptyDraft()}
          busy={busy}
          onCancel={() => setAdding(false)}
          onSubmit={(draft) => {
            setBusy(true);
            void addProjectLink(projectId, draft)
              .then(() => setAdding(false))
              .catch(() => undefined)
              .finally(() => setBusy(false));
          }}
        />
      ) : null}
    </section>
  );
}

/** Mounted by the app shell: the links editor for `ui.linksProjectId`. */
export function ProjectLinksDialogHost() {
  const projectId = useUi((s) => s.linksProjectId);
  const setLinksProject = useUi((s) => s.setLinksProject);
  const project = useModel((s) => (projectId ? s.model.projects[projectId] : undefined));
  if (!projectId || !project) return null;
  return (
    <Dialog title={`Linked repositories — ${project.title}`} onCancel={() => setLinksProject(null)}>
      <ProjectLinks projectId={projectId} />
      <div className={styles.actions}>
        <Button variant="quiet" onClick={() => setLinksProject(null)}>
          Done
        </Button>
      </div>
    </Dialog>
  );
}
