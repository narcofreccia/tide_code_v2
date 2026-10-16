import { selectTeamStages, type TeamStageStatus } from "@tide/client";
import type { Thread } from "@tide/contracts";
import { worktreeNote } from "../../lib/teamActions.ts";
import { PROVIDER_LABELS } from "../../lib/vocab.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import styles from "./TeamStrip.module.css";

const STATUS_WORDS: Record<TeamStageStatus, string> = {
  pending: "not started",
  running: "running",
  "needs-you": "needs you",
  done: "done",
  error: "error",
};

const STATUS_GLYPHS: Record<TeamStageStatus, string> = {
  pending: "○",
  running: "●",
  "needs-you": "◐",
  done: "✓",
  error: "✕",
};

/** The pipeline of a team run: one chip per stage, stage 1 being the lead itself. */
export function TeamStrip({ thread }: { thread: Thread }) {
  const model = useModel((s) => s.model);
  const stages = selectTeamStages(model, thread.id);
  const selectThread = useUi((s) => s.selectThread);
  if (thread.team === undefined || stages.length === 0) return null;
  const all = thread.team.stages;
  return (
    <nav className={styles.strip} aria-label={`Team ${thread.team.name}`}>
      <span className={styles.name}>{thread.team.name}</span>
      {stages.map(({ stage, thread: stageThread, status }, i) => (
        <span key={stage.key} className={styles.item}>
          {i > 0 ? <span className={styles.arrow} aria-hidden="true">→</span> : null}
          <button
            type="button"
            className={styles.chip}
            data-status={status}
            disabled={stageThread === undefined}
            title={`${stage.role} · ${STATUS_WORDS[status]} · ${worktreeNote(all, i)}`}
            aria-label={`${stage.role}, ${PROVIDER_LABELS[stage.provider]}, ${STATUS_WORDS[status]}`}
            onClick={() => stageThread && selectThread(stageThread.id)}
          >
            <span aria-hidden="true">{STATUS_GLYPHS[status]}</span>
            {stage.role} · {PROVIDER_LABELS[stage.provider]}
          </button>
        </span>
      ))}
    </nav>
  );
}
