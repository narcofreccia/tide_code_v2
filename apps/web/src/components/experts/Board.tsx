import { selectExpertsBoard } from "@tide/client";
import { archiveExpertsSession, nextPhase, PHASE_LABELS, setExpertsPhase } from "../../lib/expertsActions.ts";
import { useServerSettings } from "../../state/serverSettings.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { Pill } from "../ui/Pill.tsx";
import { BoardComposer } from "./BoardComposer.tsx";
import { ExpertCard } from "./ExpertCard.tsx";
import { ExpertsEmpty } from "./ExpertsEmpty.tsx";
import { DiscussionLane, FindingsFeed } from "./FindingsFeed.tsx";
import { PhaseStepper } from "./PhaseStepper.tsx";
import { SynthesisPanel } from "./SynthesisPanel.tsx";
import styles from "./Board.module.css";

/**
 * The Experts board. It is mounted twice — filling the Thread column when the
 * session is selected, and as a workbench tab while an expert's own thread is
 * open — so it owns no layout beyond its own column.
 */
export function Board({ sessionId }: { sessionId: string }) {
  const model = useModel((s) => s.model);
  const board = selectExpertsBoard(model, sessionId);
  const selectedThreadId = useUi((s) => s.selectedThreadId);
  const low = useServerSettings((s) => s.settings.decisions.grayZone.low);

  if (!board) return <ExpertsEmpty note="This experts session is gone." />;
  const { session } = board;
  // the verdict is only news until something else moves the session (a phase change, a new finding)
  const verdict = session.judge;
  const next = nextPhase(session.phase);
  const converged =
    (session.phase === "exploring" || session.phase === "discussing") && next !== undefined && verdict?.label === "true" && verdict.confidence >= low && verdict.at >= session.updatedAt
      ? { verdict, next }
      : undefined;

  return (
    <div className={styles.board} aria-label="Experts board">
      <header className={styles.header}>
        <h2 className={styles.topic} title={session.topic}>
          {session.topic}
        </h2>
        <Pill tone={session.phase === "ready" ? "needs" : "muted"}>{PHASE_LABELS[session.phase]}</Pill>
        <div className={styles.headerActions}>
          <Button variant="quiet" onClick={() => archiveExpertsSession(session.id)}>
            Archive
          </Button>
        </div>
      </header>

      <PhaseStepper sessionId={session.id} phase={session.phase} />
      {converged ? (
        <div className={styles.converged} role="status">
          <span>
            Experts agree ({converged.verdict.source} {converged.verdict.confidence.toFixed(2)})
          </span>
          <Button variant="quiet" onClick={() => setExpertsPhase(session.id, converged.next)}>
            Move to {PHASE_LABELS[converged.next]}?
          </Button>
        </div>
      ) : null}

      <div className={styles.experts} aria-label="Experts">
        {session.experts.map((expert) => (
          <ExpertCard
            key={expert.key}
            expert={expert}
            thread={board.expertThreads[expert.key]}
            selected={expert.threadId !== undefined && expert.threadId === selectedThreadId}
          />
        ))}
      </div>

      <div className={styles.lanes}>
        <FindingsFeed session={session} findings={board.findings} />
        <DiscussionLane session={session} messages={board.messages} />
      </div>

      <SynthesisPanel session={session} provider={session.lead.provider} />

      <BoardComposer session={session} />
    </div>
  );
}
