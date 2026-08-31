import { selectExpertsBoard } from "@tide/client";
import { archiveExpertsSession, PHASE_LABELS } from "../../lib/expertsActions.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { Pill } from "../ui/Pill.tsx";
import { BoardComposer } from "./BoardComposer.tsx";
import { ExpertCard } from "./ExpertCard.tsx";
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

  if (!board) return <p className={styles.empty}>This experts session is gone.</p>;
  const { session } = board;

  return (
    <div className={styles.board} aria-label="Experts board">
      <header className={styles.header}>
        <span className={styles.topic} title={session.topic}>
          {session.topic}
        </span>
        <Pill {...(session.phase === "ready" ? { tone: "accent" as const } : {})}>{PHASE_LABELS[session.phase]}</Pill>
        <div className={styles.headerActions}>
          <Button variant="quiet" onClick={() => archiveExpertsSession(session.id)}>
            Archive
          </Button>
        </div>
      </header>

      <PhaseStepper sessionId={session.id} phase={session.phase} />

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
