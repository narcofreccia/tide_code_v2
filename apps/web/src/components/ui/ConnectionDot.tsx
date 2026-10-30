import type { ConnectionStatus } from "@tide/client";
import styles from "./ConnectionDot.module.css";

const TONE: Record<ConnectionStatus, string> = {
  open: "ok",
  connecting: "pending",
  reconnecting: "pending",
  closed: "bad",
};

/** Tooltip and accessible name: what the state means for the user, not the socket word. */
export const CONNECTION_TEXT: Record<ConnectionStatus, string> = {
  open: "Connected to the server",
  connecting: "Connecting to the server…",
  reconnecting: "Connection lost, reconnecting…",
  closed: "Disconnected from the server",
};

export function ConnectionDot({ status }: { status: ConnectionStatus }) {
  const text = CONNECTION_TEXT[status];
  return <span className={`${styles.dot} ${styles[TONE[status]] ?? ""}`} title={text} aria-label={text} role="img" />;
}
