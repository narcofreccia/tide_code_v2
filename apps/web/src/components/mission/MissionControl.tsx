import { useState } from "react";
import type { ProviderKind, Thread } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { relativeTime } from "../../lib/relativeTime.ts";
import { createThread } from "../../lib/threadActions.ts";
import { PROVIDERS } from "../../lib/vocab.ts";
import { Button } from "../ui/Button.tsx";
import { Pill } from "../ui/Pill.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { Inbox } from "./Inbox.tsx";
import styles from "./MissionControl.module.css";

/** Landing view: every active thread across projects, newest activity first. */
export function MissionControl() {
  const model = useModel((s) => s.model);
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const selectThread = useUi((s) => s.selectThread);
  const [provider, setProvider] = useState<ProviderKind>("claude");

  const threads: Thread[] = Object.values(model.threads)
    .filter((t) => t.archivedAt === undefined)
    .filter((t) => selectedProjectId === null || t.projectId === selectedProjectId)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const targetProjectId = selectedProjectId ?? Object.keys(model.projects)[0];

  return (
    <section className={styles.view} aria-label="Mission Control">
      <Inbox />

      <div className={styles.header}>
        <h2 className={styles.heading}>Threads</h2>
        <div className={styles.new}>
          <select
            className={styles.provider}
            aria-label="New thread provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value as ProviderKind)}
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <Button
            variant="primary"
            disabled={targetProjectId === undefined}
            onClick={() => {
              if (targetProjectId) void createThread(targetProjectId, provider);
            }}
          >
            New thread
          </Button>
        </div>
      </div>

      {threads.length === 0 ? (
        <p className={styles.empty}>
          No active threads. {targetProjectId ? "Start one above." : "Add a project in the rail first."}
        </p>
      ) : (
        <ul className={styles.list}>
          {threads.map((t) => (
            <li key={t.id}>
              <button type="button" className={styles.row} onClick={() => selectThread(t.id)}>
                <StatusGlyph status={t.status} />
                <span className={styles.title}>{t.title}</span>
                <span className={styles.project}>{model.projects[t.projectId]?.title ?? "—"}</span>
                <Pill>{t.provider}</Pill>
                <span className={styles.time}>{relativeTime(t.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
