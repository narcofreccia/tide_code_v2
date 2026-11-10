import { useState } from "react";
import type { KnownEnvironment } from "@tide/contracts";
import {
  environmentName,
  removeEnvironment,
  setPrimaryEnvironment,
  updateEnvironment,
  useEnvironments,
} from "../../state/environments.ts";
import { runOrToast } from "../../lib/dispatchOrToast.ts";
import { protocolDiffers, protocolWarning } from "../../state/envManager.ts";
import type { ServerInfo } from "@tide/contracts";
import { Button } from "../ui/Button.tsx";
import { ConfirmDialog } from "../ui/Dialog.tsx";
import { Pill } from "../ui/Pill.tsx";
import { Icon } from "../ui/Icon.tsx";
import { EnvDot, HostBars } from "./FleetBits.tsx";
import { activeRoute, connectionLabel, harnessSummary, hostLine, httpOriginOf, statusOf } from "./envView.ts";
import { openAddMachine } from "./fleetUi.ts";
import { RoutesEditor } from "./RoutesEditor.tsx";
import { NotEncrypted } from "./NotEncrypted.tsx";
import { deviceLimitReason } from "../../state/deviceAccess.ts";
import styles from "./Environments.module.css";
import card from "./MachineCard.module.css";

/**
 * What this machine cannot do or may misunderstand: another protocol (warning), another Tide
 * version than the primary (quiet), git missing (warning), gh missing or signed out (quiet).
 */
export function machineNotes(name: string, info: ServerInfo | undefined, primaryVersion: string | undefined): { tone: "warn" | "quiet"; text: string }[] {
  if (info === undefined) return [];
  const notes: { tone: "warn" | "quiet"; text: string }[] = [];
  if (protocolDiffers(info)) notes.push({ tone: "warn", text: protocolWarning(name, info) });
  else if (primaryVersion !== undefined && info.version !== primaryVersion) {
    notes.push({ tone: "quiet", text: `${name} runs Tide ${info.version}; the primary runs ${primaryVersion}.` });
  }
  const tools = info.tools;
  if (tools !== undefined && !tools.git) notes.push({ tone: "warn", text: `git is not installed on ${name}; threads cannot use worktrees.` });
  if (tools !== undefined && !tools.gh) notes.push({ tone: "quiet", text: `The GitHub CLI (gh) is not installed on ${name}; pull requests from its threads need it.` });
  else if (tools?.gh === true && tools.ghAuth === false) notes.push({ tone: "quiet", text: `gh is not logged in on ${name}; run \`gh auth login\` there for pull requests.` });
  // R19: this device was paired with limited access; the owner raises it on that machine
  if (info.access === "limited") notes.push({ tone: "quiet", text: deviceLimitReason(name) });
  return notes;
}

function safely(what: string, run: () => void): void {
  runOrToast(what, async () => run());
}

/** One known machine: live state, host load, versions, routes and what you can do with it. */
export function MachineCard({ env }: { env: KnownEnvironment }) {
  const status = useEnvironments((s) => statusOf(s, env.id));
  const primary = useEnvironments((s) => s.primaryId === env.id);
  const primaryVersion = useEnvironments((s) => (s.primaryId === undefined ? undefined : s.statuses[s.primaryId]?.info?.version));
  const [forgetting, setForgetting] = useState(false);
  const [showRoutes, setShowRoutes] = useState(false);
  const info = status.info;
  const name = environmentName(env.id);
  const route = activeRoute(env, status);
  const origin = route ? httpOriginOf(route.url) : undefined;
  const connected = status.connection === "connected";

  return (
    <li className={styles.card} aria-label={`Machine ${name}`}>
      <div className={styles.cardHead}>
        <EnvDot connection={status.connection} />
        <span className={styles.cardName}>{name}</span>
        {primary ? (
          <Pill size="sm" tone="accent">
            primary
          </Pill>
        ) : null}
        <NotEncrypted url={route?.url} />
        <span className={styles.cardStatus}>{connectionLabel(status)}</span>
        {info?.host ? <HostBars host={info.host} /> : null}
      </div>
      {status.error && !connected ? <p className={styles.error}>{status.error}</p> : null}
      {machineNotes(name, info, primary ? undefined : primaryVersion).map((note) => (
        <p key={note.text} className={note.tone === "warn" ? card.warn : styles.note} role="note">
          {note.text}
        </p>
      ))}
      <dl className={styles.facts}>
        <dt>Host</dt>
        <dd>{hostLine(info?.host)}</dd>
        <dt>Tide</dt>
        <dd>{info?.version ?? "—"}</dd>
        <dt>Harnesses</dt>
        <dd>{harnessSummary(info)}</dd>
        {env.sshHost ?? info?.sshHost ? (
          <>
            <dt>SSH</dt>
            <dd>{env.sshHost ?? info?.sshHost}</dd>
          </>
        ) : null}
      </dl>
      <div className={styles.cardActions}>
        {status.connection === "unauthorized" ? (
          <Button variant="primary" onClick={() => openAddMachine(origin)}>
            Pair again
          </Button>
        ) : null}
        {!primary ? (
          <Button disabled={!connected} title={connected ? undefined : "Connect first"} onClick={() => safely("Switching the primary machine", () => setPrimaryEnvironment(env.id))}>
            Make primary
          </Button>
        ) : null}
        {origin ? (
          <a className={styles.linkButton} href={origin} target="_blank" rel="noreferrer">
            Open in browser
            <Icon name="external" size={12} />
          </a>
        ) : null}
        <Button variant="quiet" aria-expanded={showRoutes} onClick={() => setShowRoutes(!showRoutes)}>
          Routes · {env.routes.length}
        </Button>
        <Button variant="quietDanger" onClick={() => setForgetting(true)}>
          Forget…
        </Button>
      </div>
      {showRoutes ? (
        <RoutesEditor routes={env.routes} onChange={(routes) => safely("Saving routes", () => updateEnvironment(env.id, { routes }))} />
      ) : null}
      {forgetting ? (
        <ConfirmDialog
          title={`Forget ${name}?`}
          body={
            <>
              This client drops its routes and token for <strong>{name}</strong> and hides its projects. Nothing on that machine
              is deleted; pair again to bring it back.
            </>
          }
          confirmLabel="Forget"
          danger
          onCancel={() => setForgetting(false)}
          onConfirm={() => {
            setForgetting(false);
            safely("Forgetting the machine", () => removeEnvironment(env.id));
          }}
        />
      ) : null}
      <span className={styles.cardRoute}>{route ? route.url : "no route"}</span>
    </li>
  );
}
