import { useState } from "react";
import type { Thread } from "@tide/contracts";
import { selectIdleMs } from "@tide/client";
import { useModel } from "../../state/model.ts";
import { runOrToast } from "../../lib/dispatchOrToast.ts";
import { interruptTurn } from "../../lib/threadActions.ts";
import { steerTurn } from "../../lib/turnActions.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import styles from "./StuckBanner.module.css";

/** Triage's `stuck` at or above this shows the banner. */
export const STUCK_THRESHOLD = 0.7;
export const NUDGE_TEXT = "Status check: what are you doing right now and what is blocking you?";

/** `Looks stuck for 12 min (jev 0.78)` */
export function stuckText(idleMs: number, stuck: number): string {
  const minutes = Math.max(1, Math.round(idleMs / 60_000));
  return `Looks stuck for ${minutes} min (jev ${stuck.toFixed(2)})`;
}

/** A running thread the judge rates as stuck: stop it or ask it for a status. Dismissed per turn. */
export function StuckBanner({ thread }: { thread: Thread }) {
  const [dismissedTurn, setDismissedTurn] = useState<string | undefined>(undefined);
  const stuck = thread.triage?.stuck ?? 0;
  const visible = thread.status === "running" && stuck >= STUCK_THRESHOLD;
  // whole minutes (all the text shows), and nothing while hidden: a delta elsewhere renders nothing here
  const idleMs = useModel((s) => (visible ? Math.round(selectIdleMs(s.model, thread) / 60_000) * 60_000 : 0));
  if (!visible) return null;
  if (thread.latestTurnId !== undefined && dismissedTurn === thread.latestTurnId) return null;
  return (
    <div className={styles.banner} role="status">
      <span className={styles.text}>{stuckText(idleMs, stuck)}</span>
      <Button variant="ghost" onClick={() => interruptTurn(thread.id)}>
        Stop
      </Button>
      <Button variant="ghost" onClick={() => runOrToast("Nudge", () => steerTurn(thread.id, NUDGE_TEXT))}>
        Nudge
      </Button>
      <Button variant="quiet" aria-label="Dismiss" title="Dismiss for this turn" onClick={() => setDismissedTurn(thread.latestTurnId)}>
        <Icon name="close" size={14} />
      </Button>
    </div>
  );
}
