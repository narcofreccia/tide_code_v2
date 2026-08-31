import { useEffect } from "react";
import { useUi } from "../../state/ui.ts";
import { Board } from "./Board.tsx";
import styles from "./Board.module.css";

/** The board filling the Thread column; Esc returns to wherever it was opened from. */
export function ExpertsView({ sessionId }: { sessionId: string }) {
  const closeExperts = useUi((s) => s.closeExperts);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
      closeExperts();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeExperts]);

  return (
    <section className={styles.column} aria-label="Experts">
      <Board sessionId={sessionId} />
    </section>
  );
}
