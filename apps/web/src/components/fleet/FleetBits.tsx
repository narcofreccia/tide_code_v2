import type { EnvConnection } from "../../state/environments.ts";
import { useEnvironments, environmentName } from "../../state/environments.ts";
import { Pill } from "../ui/Pill.tsx";
import { CONNECTION_TONE, formatBytes, memUse, percent, type HostFacts } from "./envView.ts";
import styles from "./Fleet.module.css";

/** Past this share a bar takes the needs-you tint. */
const HOT = 0.8;

/** One dot per environment: green connected, amber connecting, red refused, grey offline. */
export function EnvDot({ connection }: { connection: EnvConnection }) {
  return <span className={`${styles.dot} ${styles[CONNECTION_TONE[connection]] ?? ""}`} role="img" aria-label={connection} title={connection} />;
}

function Bar({ name, label, value, title }: { name: string; label: string; value: number; title: string }) {
  return (
    <span className={`${styles.bar} ${value > HOT ? styles.hot : ""}`} title={title}>
      <span className={styles.barName}>{name}</span>
      <meter className={styles.meter} aria-label={label} min={0} max={1} low={HOT} high={HOT} optimum={0} value={value} />
    </span>
  );
}

/** cpu and memory as 48px meters (needs-you tint past 80%) plus the busy-thread count. */
export function HostBars({ host }: { host: HostFacts }) {
  const mem = memUse(host);
  return (
    <span className={styles.bars}>
      <Bar name="cpu" label="CPU load" value={host.cpuLoad} title={`CPU ${percent(host.cpuLoad)} · sampled over the last second`} />
      <Bar
        name="mem"
        label="Memory in use"
        value={mem}
        title={`${percent(mem)} of memory in use · ${formatBytes(host.memFree)} available`}
      />
      <span className={`${styles.busy} ${host.busyThreads > 0 ? styles.busyOn : ""}`} title="Agent sessions running on this machine">
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
    <Pill size="sm" tone="muted" className={`${styles.tag} ${offline ? styles.tagOffline : ""}`} title={`Runs on ${name}${offline ? ` (${connection})` : ""}`}>
      <span className={styles.tagName}>{name}</span>
    </Pill>
  );
}
