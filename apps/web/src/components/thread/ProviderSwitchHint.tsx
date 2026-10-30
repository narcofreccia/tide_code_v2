import { selectThreadTurns } from "@tide/client";
import type { Thread } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { useThreadHarnessLabel } from "../../state/providers.ts";
import styles from "./Composer.module.css";

/**
 * Shown once the thread has turns and its provider differs from the one that ran
 * the last turn (or a handoff is already pending): the next turn gets a text
 * handoff, not the native session.
 */
export function ProviderSwitchHint({ thread }: { thread: Thread }) {
  const switched = useModel((s) => {
    const turns = selectThreadTurns(s.model, thread.id);
    const last = turns[turns.length - 1];
    if (!last) return false;
    return thread.pendingHandoffId !== undefined || (last.provider !== undefined && last.provider !== thread.provider);
  });
  const label = useThreadHarnessLabel(thread);
  if (!switched) return null;
  return (
    <p className={styles.switchHint}>
      History will be handed over to {label} as text (lossy: no tool state)
    </p>
  );
}
