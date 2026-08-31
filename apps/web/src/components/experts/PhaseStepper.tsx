import type { ExpertsPhase } from "@tide/contracts";
import { nextPhase, PHASE_LABELS, PHASE_STEPS, setExpertsPhase } from "../../lib/expertsActions.ts";
import { Button } from "../ui/Button.tsx";
import styles from "./Board.module.css";

/** Exploring → Discussing → Synthesizing → Ready; the user drives every step. */
export function PhaseStepper({ sessionId, phase }: { sessionId: string; phase: ExpertsPhase }) {
  const current = PHASE_STEPS.indexOf(phase);
  const next = nextPhase(phase);
  return (
    <div className={styles.stepper} aria-label="Phase">
      <ol className={styles.steps}>
        {PHASE_STEPS.map((step, index) => (
          <li
            key={step}
            className={`${styles.step} ${step === phase ? styles.stepActive : ""} ${
              current > -1 && index < current ? styles.stepDone : ""
            }`}
            aria-current={step === phase ? "step" : undefined}
          >
            <button type="button" className={styles.stepButton} onClick={() => setExpertsPhase(sessionId, step)}>
              {PHASE_LABELS[step]}
            </button>
          </li>
        ))}
      </ol>
      <Button
        variant="primary"
        disabled={next === undefined}
        title={next === undefined ? "The panel is at the last phase" : `Move to ${PHASE_LABELS[next]}`}
        onClick={() => {
          if (next !== undefined) setExpertsPhase(sessionId, next);
        }}
      >
        Next phase
      </Button>
    </div>
  );
}
