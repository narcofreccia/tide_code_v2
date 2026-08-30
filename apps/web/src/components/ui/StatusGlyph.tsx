import type { Thread } from "@tide/contracts";
import styles from "./StatusGlyph.module.css";

/** ○ idle · ● running · ◐ needs you · ✕ error · ⏸ interrupted */
const GLYPH: Record<Thread["status"], string> = {
  idle: "○",
  running: "●",
  interrupted: "⏸",
  error: "✕",
};

export function StatusGlyph({ status }: { status: Thread["status"] }) {
  return (
    <span className={`${styles.glyph} ${styles[status] ?? ""}`} title={status} aria-label={status} role="img">
      {GLYPH[status]}
    </span>
  );
}
