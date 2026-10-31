import type { RunPlanRow, RunService, RunServiceStatus } from "@tide/contracts";
import { isUp, previewPort, type StackService } from "@tide/client";
import { openPreviewTab } from "../../../state/workbench.ts";
import { restartService, showServiceLog, startStack, stopStack } from "../../../state/run.ts";
import { Button } from "../../ui/Button.tsx";
import { Checkbox } from "../../ui/Choice.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { Pill } from "../../ui/Pill.tsx";
import { copyText } from "./PlanPreviewDialog.tsx";
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

/** The server's reason when a root-repo service died at once in a worktree without its dependencies. */
export const isDepsMissing = (reason: string | undefined): boolean => reason?.startsWith("dependencies missing") === true;

/** The install step to copy for a worktree that lacks `node_modules` / a venv, run in `cwd`. */
export function installCommand(service: Pick<RunService, "kind" | "command">, cwd?: string): string {
  const py = service.kind === "uvicorn" || service.kind === "worker";
  const runner = /^\s*(pnpm|yarn|bun)\b/.exec(service.command)?.[1];
  const install = py ? "python -m venv venv && source venv/bin/activate && pip install -r requirements.txt" : `${runner ?? "npm"} install`;
  return cwd === undefined ? install : `cd ${JSON.stringify(cwd)} && ${install}`;
}

/** `cwd` relative to the root it was planned under: "." for the root itself, else the sub-path. */
export function relativeCwd(cwd: string, root: string): string | undefined {
  const base = root.replace(/[\\/]+$/, "");
  if (cwd === base) return ".";
  return cwd.startsWith(`${base}/`) || cwd.startsWith(`${base}\\`) ? cwd.slice(base.length + 1) : undefined;
}

const TAIL = 14;

/**
 * Splits a long command for a middle ellipsis: the head shrinks with `…`, the tail (the script or
 * last flag, usually what tells two commands apart) always shows. Short commands stay whole.
 */
export function splitCommand(command: string): { head: string; tail: string } {
  const flat = command.replace(/\s+/g, " ").trim();
  if (flat.length <= TAIL * 2) return { head: flat, tail: "" };
  return { head: flat.slice(0, -TAIL), tail: flat.slice(-TAIL) };
}

/** One stack service: toggle · state dot · name · kind · ports · hover actions; reason below when it failed. */
export function RunRow({
  projectId,
  threadId,
  item,
  selected,
  status,
  planRow,
  rootPath,
  onToggle,
}: {
  projectId: string;
  threadId: string | undefined;
  item: StackService;
  selected: boolean;
  status: RunServiceStatus | undefined;
  planRow: RunPlanRow | undefined;
  /** the plan's root when the project's own repo runs from a worktree: root rows show their cwd under it */
  rootPath?: string | undefined;
  onToggle: (key: string, on: boolean) => void;
}) {
  const { service, key } = item;
  const state = status?.state;
  const live = state !== undefined && (isUp(state) || state === "starting");
  const ports = servicePorts(item, status, planRow);
  const port = openablePort(item, status, planRow);
  const reason = state === "failed" ? status?.reason : undefined;
  const blocked = !live && planRow?.blocked !== undefined ? planRow.blocked : undefined;
  const command = splitCommand(service.command);
  const env = Object.entries(service.env);
  const where = rootPath !== undefined && item.repoId === "root" && planRow !== undefined ? relativeCwd(planRow.cwd, rootPath) : undefined;
  const install = isDepsMissing(reason) ? installCommand(service, planRow?.cwd) : undefined;

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
        {where === undefined ? null : (
          <span className={styles.where} title={planRow?.cwd}>
            {where}
          </span>
        )}
        <span className={styles.command} title={service.command}>
          <span className={styles.commandHead}>{command.head}</span>
          {command.tail === "" ? null : <span className={styles.commandTail}>{command.tail}</span>}
        </span>
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
            <Button variant="quiet" aria-label={`Start ${service.name}`} title="Start" onClick={() => void startStack(projectId, { ...(threadId === undefined ? {} : { threadId }), selected: [key] })}>
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
      {env.length === 0 ? null : (
        <span className={styles.envChips} aria-label={`Environment of ${service.name}`}>
          {env.map(([k, v]) => (
            <span key={k} className={styles.envChip} title={`${k}=${v}`}>
              {k}={v}
            </span>
          ))}
        </span>
      )}
      {reason === undefined ? null : <p className={styles.reason}>{reason}</p>}
      {install === undefined ? null : (
        <span className={styles.fix}>
          <button type="button" className={styles.hint} title="Copy the install command" aria-label={`Copy ${install}`} onClick={() => copyText(install)}>
            <Icon name="copy" size={12} />
            {install}
          </button>
        </span>
      )}
      {blocked === undefined ? null : <p className={`${styles.reason} ${styles.blocked}`}>{blocked}</p>}
    </div>
  );
}
