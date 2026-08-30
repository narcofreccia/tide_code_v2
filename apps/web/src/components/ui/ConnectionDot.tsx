import type { ConnectionStatus } from "@tide/client";
import styles from "./ConnectionDot.module.css";

const TONE: Record<ConnectionStatus, string> = {
  open: "ok",
  connecting: "pending",
  reconnecting: "pending",
  closed: "bad",
};

export function ConnectionDot({ status }: { status: ConnectionStatus }) {
  return (
    <span
      className={`${styles.dot} ${styles[TONE[status]] ?? ""}`}
      title={`connection ${status}`}
      aria-label={`connection ${status}`}
      role="img"
    />
  );
}
