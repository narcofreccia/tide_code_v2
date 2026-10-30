import type { EnvConnection } from "../../state/environments.ts";
import { useEnvironments, environmentName } from "../../state/environments.ts";
import { CONNECTION_TONE, memUse, percent, type HostFacts } from "./envView.ts";
import styles from "./Fleet.module.css";

/** One dot per environment: green connected, amber connecting, red refused, grey offline. */
export function EnvDot({ connection }: { connection: EnvConnection }) {
  return <span className={`${styles.dot} ${styles[CONNECTION_TONE[connection]] ?? ""}`} role="img" aria-label={connection} title={connection} />;
}

/** cpu and memory as native meters (amber past 70%, red past 90%) plus the busy-thread count. */
export function HostBars({ host }: { host: HostFacts }) {
  const mem = memUse(host);
  return (
    <span className={styles.bars}>
      <span className={styles.bar} title={`CPU ${percent(host.cpuLoad)} over the last minute`}>
        cpu
        <meter className={styles.meter} aria-label="CPU load" min={0} max={1} low={0.7} high={0.9} optimum={0} value={host.cpuLoad} />
      </span>
      <span className={styles.bar} title={`Memory ${percent(mem)} in use`}>
        mem
        <meter className={styles.meter} aria-label="Memory in use" min={0} max={1} low={0.7} high={0.9} optimum={0} value={mem} />
      </span>
      <span className={styles.busy} title="Agent sessions running on this machine">
        {host.busyThreads} busy
      </span>
    </span>
  );
}

/** The small machine tag on project rows; rendered only when the caller has more than one machine. */
export function EnvTag({ envId }: { envId: string | undefined }) {
  const connection = useEnvironments((s) => (envId === undefined ? undefined : s.statuses[envId]?.connection));
  if (envId === undefined) return null;
  const name = environmentName(envId);
  const offline = connection !== undefined && connection !== "connected";
  return (
    <span className={`${styles.tag} ${offline ? styles.tagOffline : ""}`} title={`Runs on ${name}${offline ? ` (${connection})` : ""}`}>
      {name}
    </span>
  );
}
