import { useModel } from "../../state/model.ts";
import { useLatestTurnStatus, useSelectedThread } from "../../state/hooks.ts";
import { ConnectionDot } from "../ui/ConnectionDot.tsx";
import styles from "./StatusBar.module.css";

const LABEL: Record<string, string> = {
  open: "connected",
  connecting: "connecting…",
  reconnecting: "reconnecting…",
  closed: "disconnected",
};

export function StatusBar() {
  const status = useModel((s) => s.status);
  const environmentId = useModel((s) => s.environmentId);
  const lastError = useModel((s) => s.lastError);
  const thread = useSelectedThread();
  const turnStatus = useLatestTurnStatus(thread);

  return (
    <footer className={styles.bar}>
      <span className={styles.item}>
        <ConnectionDot status={status} />
        {LABEL[status] ?? status}
      </span>
      <span className={styles.mono}>{environmentId ?? "no environment"}</span>
      {thread ? <span className={styles.item}>thread: {turnStatus ?? thread.status}</span> : null}
      {lastError ? <span className={styles.error}>{lastError}</span> : null}
    </footer>
  );
}
