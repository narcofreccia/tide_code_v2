import type { RunPlanRow, RunServiceStatus } from "@tide/contracts";
import { isUp, previewPort, type StackService } from "@tide/client";
import { openPreviewTab } from "../../../state/workbench.ts";
import { restartService, showServiceLog, startStack, stopStack } from "../../../state/run.ts";
import { Button } from "../../ui/Button.tsx";
import { Checkbox } from "../../ui/Choice.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { Pill } from "../../ui/Pill.tsx";
import styles from "./Run.module.css";

const STATE_TITLE: Record<RunServiceStatus["state"], string> = {
  starting: "Starting",
  ready: "Ready",
  running: "Running",
  exited: "Exited",
  failed: "Failed",
  external: "running outside Tide",
};

interface PortView {
  listen: string;
  port: number;
  was?: number;
}

/** Preferred ports of the profile, replaced by what the session (or last plan) actually assigned. */
export function servicePorts(item: StackService, status: RunServiceStatus | undefined, planRow: RunPlanRow | undefined): PortView[] {
  return item.service.listens.map((listen) => {
    const actual = status?.ports[listen.name] ?? planRow?.ports[listen.name];
    return actual === undefined || actual === listen.port
      ? { listen: listen.name, port: listen.port }
      : { listen: listen.name, port: actual, was: listen.port };
  });
}

/** The ports a browser could open: the session's, else the plan's, else the preferred ones. */
function openablePort(item: StackService, status: RunServiceStatus | undefined, planRow: RunPlanRow | undefined): number | undefined {
  const preferred = Object.fromEntries(item.service.listens.map((l) => [l.name, l.port]));
  const ports = status && Object.keys(status.ports).length > 0 ? status.ports : planRow?.ports ?? preferred;
  return previewPort(ports);
}

/** One stack service: toggle · state dot · name · kind · ports · hover actions; reason below when it failed. */
export function RunRow({
  projectId,
  threadId,
  item,
  selected,
  status,
  planRow,
  onToggle,
}: {
  projectId: string;
  threadId: string | undefined;
  item: StackService;
  selected: boolean;
  status: RunServiceStatus | undefined;
  planRow: RunPlanRow | undefined;
  onToggle: (key: string, on: boolean) => void;
}) {
  const { service, key } = item;
  const state = status?.state;
  const live = state !== undefined && (isUp(state) || state === "starting");
  const ports = servicePorts(item, status, planRow);
  const port = openablePort(item, status, planRow);
  const reason = state === "failed" ? status?.reason : undefined;
  const blocked = !live && planRow?.blocked !== undefined ? planRow.blocked : undefined;

  return (
    <div className={styles.row} data-service={key}>
      <div className={styles.line}>
        <Checkbox
          checked={selected}
          aria-label={`Include ${service.name} in the stack`}
          onChange={(e) => onToggle(key, e.target.checked)}
        />
        <span
          className={styles.dot}
          data-state={state ?? "idle"}
          role="img"
          aria-label={state === undefined ? "Stopped" : STATE_TITLE[state]}
          title={state === undefined ? "Stopped" : STATE_TITLE[state]}
        />
        <span className={styles.name}>{service.name}</span>
        {service.kind === undefined ? null : <Pill size="sm">{service.kind}</Pill>}
        <span className={styles.ports}>
          {ports.map((p) => (
            <span
              key={p.listen}
              className={p.was === undefined ? undefined : styles.moved}
              title={p.was === undefined ? p.listen : `was ${p.was} → ${p.port}`}
            >
              :{p.port}
            </span>
          ))}
        </span>
        <span className={styles.actions}>
          {live ? null : (
            <Button variant="quiet" aria-label={`Start ${service.name}`} title="Start" onClick={() => void startStack(projectId, { selected: [key] })}>
              <Icon name="play" size={14} />
            </Button>
          )}
          {live && state !== "external" ? (
            <Button variant="quiet" aria-label={`Restart ${service.name}`} title="Restart" onClick={() => void restartService(projectId, key)}>
              <Icon name="refresh" size={14} />
            </Button>
          ) : null}
          {live ? (
            <Button variant="quiet" aria-label={`Stop ${service.name}`} title="Stop" onClick={() => void stopStack(projectId, key)}>
              <Icon name="stop" size={14} />
            </Button>
          ) : null}
          {threadId !== undefined && port !== undefined ? (
            <Button
              variant="quiet"
              aria-label={`Preview ${service.name}`}
              title={`Preview http://localhost:${port}`}
              onClick={() => openPreviewTab(threadId, `http://localhost:${port}`)}
            >
              <Icon name="external" size={14} />
            </Button>
          ) : null}
          {threadId !== undefined && state !== undefined && state !== "external" ? (
            <Button
              variant="quiet"
              aria-label={`Logs of ${service.name}`}
              title="Logs"
              onClick={() => void showServiceLog(threadId, projectId, service.name, status?.ptyId)}
            >
              <Icon name="terminal" size={14} />
            </Button>
          ) : null}
        </span>
      </div>
      {reason === undefined ? null : <p className={styles.reason}>{reason}</p>}
      {blocked === undefined ? null : <p className={`${styles.reason} ${styles.blocked}`}>{blocked}</p>}
    </div>
  );
}
