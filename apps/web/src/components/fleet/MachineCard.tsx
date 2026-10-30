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
import { Button } from "../ui/Button.tsx";
import { ConfirmDialog } from "../ui/Dialog.tsx";
import { Pill } from "../ui/Pill.tsx";
import { Icon } from "../ui/Icon.tsx";
import { EnvDot, HostBars } from "./FleetBits.tsx";
import { activeRoute, connectionLabel, harnessSummary, hostLine, httpOriginOf, statusOf } from "./envView.ts";
import { openAddMachine } from "./fleetUi.ts";
import { RoutesEditor } from "./RoutesEditor.tsx";
import styles from "./Environments.module.css";

function safely(what: string, run: () => void): void {
  runOrToast(what, async () => run());
}

/** One known machine: live state, host load, versions, routes and what you can do with it. */
export function MachineCard({ env }: { env: KnownEnvironment }) {
  const status = useEnvironments((s) => statusOf(s, env.id));
  const primary = useEnvironments((s) => s.primaryId === env.id);
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
        <span className={styles.cardStatus}>{connectionLabel(status)}</span>
        {info?.host ? <HostBars host={info.host} /> : null}
      </div>
      {status.error && !connected ? <p className={styles.error}>{status.error}</p> : null}
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
