import { useState } from "react";
import { selectAllThreads } from "@tide/client";
import type { Thread } from "@tide/contracts";
import { formatUsd } from "../../lib/glassBox.ts";
import { relativeTime } from "../../lib/relativeTime.ts";
import { threadHarnessLabel } from "../../lib/vocab.ts";
import { useProvidersSnapshot } from "../../state/providers.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { requestDelete, unarchiveThread } from "../../lib/threadActions.ts";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Choice.tsx";
import { Icon } from "../ui/Icon.tsx";
import { ThreadGlyph } from "../ui/StatusGlyph.tsx";
import { MergeGlyph, PrGlyph } from "../ui/VcsBadges.tsx";
import styles from "./AllThreads.module.css";

function Cells({ thread, archived }: { thread: Thread; archived: boolean }) {
  const providers = useProvidersSnapshot();
  return (
    <>
      <ThreadGlyph thread={thread} />
      <span className={styles.title}>{thread.title}</span>
      <span className={styles.muted}>{threadHarnessLabel(providers, thread)}</span>
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
 * Every thread of one project — the "all threads →" of a project card. Rows open
 * the thread on click; with "Archived" on, archived threads open read-only and
 * each offers Restore (`thread.unarchive`).
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
        <div className={styles.headText}>
          <Button variant="quiet" className={styles.back} onClick={() => showAllThreads(null)}>
            <Icon name="chevronRight" size={12} className={`${styles.backIcon}`} />
            Mission Control
          </Button>
          <h1 className={styles.pageTitle}>{project?.title ?? "Unknown project"}</h1>
          <span className={styles.meta}>
            {threads.length} {archived ? "archived" : "threads"}
          </span>
        </div>
        <Checkbox className={styles.toggle} checked={archived} onChange={(e) => setArchived(e.target.checked)}>
          Archived
        </Checkbox>
      </div>
      <div className={`${styles.row} ${styles.header} ${archived ? styles.withRestore : ""}`} aria-hidden="true">
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
                <div className={styles.archivedItem}>
                  <button
                    type="button"
                    className={styles.row}
                    aria-label={`${thread.title} (archived)`}
                    onClick={() => selectThread(thread.id)}
                  >
                    <Cells thread={thread} archived />
                  </button>
                  <Button variant="quiet" className={styles.restore} onClick={() => unarchiveThread(thread.id)}>
                    Restore
                  </Button>
                  <Button variant="quiet" className={styles.restore} onClick={() => requestDelete(thread)}>
                    Delete…
                  </Button>
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
