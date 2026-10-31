import { useState } from "react";
import type { RunConflict, RunPlan, RunPlanRow, RunReadiness, RunRepo } from "@tide/contracts";
import type { StackService } from "@tide/client";
import { planStack, setRunStack, startStack } from "../../../state/run.ts";
import { showToast } from "../../../state/toast.ts";
import { Button } from "../../ui/Button.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { Icon } from "../../ui/Icon.tsx";
import styles from "./Run.module.css";

const MAX_CHIPS = 4;

function copy(text: string): void {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard) return;
  void clipboard.writeText(text).then(
    () => showToast("Copied"),
    () => undefined,
  );
}

/** `<repoKey>.<serviceId>.<listen>` (or an external party) → the service key, when it is one. */
export function conflictServiceKey(party: string): string | undefined {
  const match = /^([a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9-]*)(\.|$)/.exec(party);
  return match?.[1];
}

function readinessText(readiness: RunReadiness): string {
  if (readiness.kind === "port") return readiness.listen === undefined ? "port" : `port ${readiness.listen}`;
  if (readiness.kind === "log") return `log /${readiness.pattern}/`;
  return "none";
}

function EnvChips({ env }: { env: Record<string, string> }) {
  const entries = Object.entries(env);
  const shown = entries.slice(0, MAX_CHIPS);
  const rest = entries.slice(MAX_CHIPS);
  if (entries.length === 0) return <span className={styles.was}>none</span>;
  return (
    <span className={styles.chips}>
      {shown.map(([k, v]) => (
        <button key={k} type="button" className={styles.chip} title={`Copy ${k}=${v}`} onClick={() => copy(`${k}=${v}`)}>
          {k}={v}
        </button>
      ))}
      {rest.length === 0 ? null : (
        <span className={styles.was} title={rest.map(([k, v]) => `${k}=${v}`).join("\n")}>
          +{rest.length}
        </span>
      )}
    </span>
  );
}

function PortCell({
  row,
  pins,
  onPin,
}: {
  row: RunPlanRow;
  pins: Record<string, number>;
  onPin: (pinKey: string, port: number | undefined) => void;
}) {
  const names = Object.keys(row.ports);
  if (names.length === 0) return <span className={styles.was}>none</span>;
  return (
    <span className={styles.portCell}>
      {names.map((listen) => {
        const port = row.ports[listen] as number;
        const was = row.changedFrom[listen];
        const pinKey = `${row.key}.${listen}`;
        const commit = (raw: string): void => {
          const next = Number(raw);
          if (!Number.isInteger(next) || next < 1 || next > 65535 || next === port) return;
          onPin(pinKey, next);
        };
        return (
          <span key={listen} className={styles.portCell}>
            <input
              key={`${pinKey}:${port}`}
              className={`${styles.portInput} ${was === undefined ? "" : styles.portMoved}`}
              aria-label={`Port ${listen} of ${row.name}`}
              title={row.fixed ? "fixed port: set in the project's own config" : `pin ${listen}`}
              inputMode="numeric"
              defaultValue={String(port)}
              disabled={row.fixed}
              onBlur={(e) => commit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit(e.currentTarget.value);
              }}
            />
            {was === undefined ? null : <span className={styles.was}>was {was}</span>}
            {pins[pinKey] === undefined ? null : (
              <Button variant="link" onClick={() => onPin(pinKey, undefined)}>
                clear pin
              </Button>
            )}
          </span>
        );
      })}
    </span>
  );
}

/** Copyable (never applied) edit for two Tauri apps that both insist on the same devUrl port. */
export function tauriHint(repoPath: string, port: number): string {
  return `change build.devUrl in ${repoPath}/src-tauri/tauri.conf.json (and the vite port) to ${port + 10}`;
}

function ConflictItem({
  conflict,
  plan,
  services,
  repos,
  onDeselect,
}: {
  conflict: RunConflict;
  plan: RunPlan;
  services: StackService[];
  repos: RunRepo[];
  onDeselect: (key: string) => void;
}) {
  const nameOf = (key: string): string =>
    plan.rows.find((r) => r.key === key)?.name ?? services.find((s) => s.key === key)?.service.name ?? key;
  const own = conflictServiceKey(conflict.key);
  const otherCandidate = conflictServiceKey(conflict.with);
  const other = otherCandidate !== undefined && plan.rows.some((r) => r.key === otherCandidate) ? otherCandidate : undefined;
  const parties = [own, other].filter((k): k is string => k !== undefined);
  const rowOf = (key: string): RunPlanRow | undefined => plan.rows.find((r) => r.key === key);
  const bothFixed = own !== undefined && other !== undefined && rowOf(own)?.fixed === true && rowOf(other)?.fixed === true;
  const tauri = bothFixed ? parties.find((k) => services.find((s) => s.key === k)?.service.kind === "tauri") : undefined;
  const tauriRepo = tauri === undefined ? undefined : repos.find((r) => r.repoId === services.find((s) => s.key === tauri)?.repoId);
  const hint = tauriRepo === undefined ? undefined : tauriHint(tauriRepo.path, conflict.port);

  return (
    <div className={styles.conflict}>
      <span>
        <strong>{own === undefined ? conflict.key : nameOf(own)}</strong> and{" "}
        <strong>{other === undefined ? conflict.with : nameOf(other)}</strong> both want :{conflict.port}. {conflict.reason}
      </span>
      {hint === undefined ? null : (
        <button type="button" className={styles.hint} title="Copy" onClick={() => copy(hint)}>
          {hint}
        </button>
      )}
      <span className={styles.conflictActions}>
        {parties.map((key) => (
          <Button key={key} variant="ghost" onClick={() => onDeselect(key)}>
            Deselect {nameOf(key)}
          </Button>
        ))}
      </span>
    </div>
  );
}

/** "Start stack" dry run: ports, env, readiness, conflicts; pins and deselects re-plan live. */
export function PlanPreviewDialog({
  projectId,
  initialPlan,
  initialSelected,
  initialPins,
  services,
  repos,
  onClose,
}: {
  projectId: string;
  initialPlan: RunPlan;
  initialSelected: string[];
  initialPins: Record<string, number>;
  services: StackService[];
  repos: RunRepo[];
  onClose: () => void;
}) {
  const [plan, setPlan] = useState(initialPlan);
  const [selected, setSelected] = useState(initialSelected);
  const [pins, setPins] = useState(initialPins);
  const [busy, setBusy] = useState(false);

  const replan = async (nextSelected: string[], nextPins: Record<string, number>): Promise<void> => {
    setSelected(nextSelected);
    setPins(nextPins);
    setBusy(true);
    void setRunStack(projectId, { selected: nextSelected, pins: nextPins });
    const next = await planStack(projectId, { selected: nextSelected, pins: nextPins });
    if (next) setPlan(next);
    setBusy(false);
  };

  const onPin = (pinKey: string, port: number | undefined): void => {
    const next = { ...pins };
    if (port === undefined) delete next[pinKey];
    else next[pinKey] = port;
    void replan(selected, next);
  };

  const startable = plan.rows.filter((r) => r.blocked === undefined).length;
  const blocked = plan.status === "blocked";

  return (
    <Dialog title="Start stack" size="lg" onCancel={onClose}>
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Service</th>
              <th>Port</th>
              <th>Env injected</th>
              <th>Readiness</th>
              <th aria-label="Warnings" />
            </tr>
          </thead>
          <tbody>
            {plan.rows.map((row) => (
              <tr key={row.key} className={row.blocked === undefined ? undefined : styles.rowBlocked}>
                <td title={row.command}>{row.name}</td>
                <td>
                  <PortCell row={row} pins={pins} onPin={onPin} />
                </td>
                <td>
                  <EnvChips env={row.env} />
                </td>
                <td>{readinessText(row.readiness)}</td>
                <td>
                  {row.blocked === undefined ? null : (
                    <span className={styles.warnIcon} title={row.blocked}>
                      <Icon name="warning" size={14} label={`${row.name}: ${row.blocked}`} />
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {plan.conflicts.length === 0 ? null : (
        <section className={styles.conflicts} aria-label="Conflicts">
          <h4 className={styles.conflictsTitle}>Conflicts</h4>
          {plan.conflicts.map((c) => (
            <ConflictItem
              key={`${c.key}:${c.with}`}
              conflict={c}
              plan={plan}
              services={services}
              repos={repos}
              onDeselect={(key) => void replan(selected.filter((k) => k !== key), pins)}
            />
          ))}
        </section>
      )}
      {plan.warnings.length === 0 ? null : (
        <ul className={styles.warnings}>
          {plan.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <div className={styles.footer}>
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={blocked || busy || startable === 0}
          title={blocked ? "Resolve the conflicts first" : undefined}
          onClick={() => {
            setBusy(true);
            void startStack(projectId, { selected, pins }).then((session) => {
              setBusy(false);
              if (session) onClose();
            });
          }}
        >
          Start {startable} {startable === 1 ? "service" : "services"}
        </Button>
      </div>
    </Dialog>
  );
}
