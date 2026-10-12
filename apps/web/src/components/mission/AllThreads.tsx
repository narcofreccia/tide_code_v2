import { useState } from "react";
import { selectAllThreads } from "@tide/client";
import type { Thread } from "@tide/contracts";
import { formatUsd } from "../../lib/glassBox.ts";
import { relativeTime } from "../../lib/relativeTime.ts";
import { PROVIDER_LABELS } from "../../lib/vocab.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Choice.tsx";
import { ThreadGlyph } from "../ui/StatusGlyph.tsx";
import { MergeGlyph, PrGlyph } from "../ui/VcsBadges.tsx";
import styles from "./AllThreads.module.css";

function Cells({ thread, archived }: { thread: Thread; archived: boolean }) {
  return (
    <>
      <ThreadGlyph thread={thread} />
      <span className={styles.title}>{thread.title}</span>
      <span className={styles.muted}>{PROVIDER_LABELS[thread.provider]}</span>
      <span className={styles.mono} title={thread.model ?? "harness default"}>
        {thread.model ?? "default"}
      </span>
      <span className={styles.vcs}>
        <span className={styles.mono} title={thread.worktreePath ?? "main checkout"}>
          {thread.branch ?? "—"}
        </span>
        <PrGlyph pr={thread.pr} />
        <MergeGlyph thread={thread} />
      </span>
      <span className={styles.num}>
        {relativeTime(archived ? (thread.archivedAt ?? thread.updatedAt) : thread.updatedAt)}
      </span>
      <span className={styles.num}>{thread.totalCostUsd === undefined ? "—" : formatUsd(thread.totalCostUsd)}</span>
    </>
  );
}

/**
 * Every thread of one project — the "all threads →" of a project card. Live
 * threads open on click. With "Archived" on, archived threads are listed
 * read-only: the contracts have no unarchive command (only `thread.archive`),
 * so there is nothing to offer beyond showing what was there.
 */
export function AllThreads({ projectId }: { projectId: string }) {
  const model = useModel((s) => s.model);
  const selectThread = useUi((s) => s.selectThread);
  const showAllThreads = useUi((s) => s.showAllThreads);
  const [archived, setArchived] = useState(false);
  const project = model.projects[projectId];
  const threads = selectAllThreads(model, projectId, { archived });

  return (
    <section className={styles.view} aria-label="All threads">
      <div className={styles.head}>
        <Button variant="link" onClick={() => showAllThreads(null)}>
          ← Mission Control
        </Button>
        <h1 className={styles.pageTitle}>{project?.title ?? "Unknown project"}</h1>
        <span className={styles.muted}>
          {threads.length} {archived ? "archived" : "threads"}
        </span>
        <Checkbox className={styles.toggle} checked={archived} onChange={(e) => setArchived(e.target.checked)}>
          Archived
        </Checkbox>
      </div>
      <div className={`${styles.row} ${styles.header}`} aria-hidden="true">
        <span />
        <span>Thread</span>
        <span>Provider</span>
        <span>Model</span>
        <span>Branch</span>
        <span className={styles.num}>{archived ? "Archived" : "Active"}</span>
        <span className={styles.num}>Cost</span>
      </div>
      {threads.length === 0 ? (
        <p className={styles.empty}>{archived ? "No archived threads." : "No threads yet."}</p>
      ) : (
        <ul className={styles.list} aria-label={archived ? "Archived threads" : "Threads"}>
          {threads.map((thread) => (
            <li key={thread.id}>
              {archived ? (
                <div className={styles.row} aria-label={`${thread.title} (archived)`}>
                  <Cells thread={thread} archived />
                </div>
              ) : (
                <button type="button" className={styles.row} onClick={() => selectThread(thread.id)}>
                  <Cells thread={thread} archived={false} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
