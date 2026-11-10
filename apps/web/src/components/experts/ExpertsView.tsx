import { useRef } from "react";
import { useEscape } from "../../lib/useEscape.ts";
import { useUi } from "../../state/ui.ts";
import { Board } from "./Board.tsx";
import styles from "./Board.module.css";

/** The board filling the Thread column; Esc returns to wherever it was opened from. */
export function ExpertsView({ sessionId }: { sessionId: string }) {
  const closeExperts = useUi((s) => s.closeExperts);
  const root = useRef<HTMLElement>(null);
  // a text field is left first (lib/useEscape), so a half-typed message is not dropped with the board
  useEscape(closeExperts, { root });

  return (
    <section ref={root} className={styles.column} aria-label="Experts">
      <Board sessionId={sessionId} />
    </section>
  );
}
