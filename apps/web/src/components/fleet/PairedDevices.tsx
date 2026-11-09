import { useCallback, useEffect, useState } from "react";
import type { PairedClient } from "@tide/contracts";
import { call } from "../../state/model.ts";
import { useEnvironments } from "../../state/environments.ts";
import { errorText } from "../../lib/dispatchOrToast.ts";
import { relativeTime } from "../../lib/relativeTime.ts";
import { Button } from "../ui/Button.tsx";
import { ConfirmDialog } from "../ui/Dialog.tsx";
import { Pill } from "../ui/Pill.tsx";
import { SettingRow } from "../settings/ui/SettingRow.tsx";
import { envOpt } from "./envView.ts";
import styles from "./PairedDevices.module.css";

const day = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/**
 * R17: the devices that paired with this machine, each holding its own token. Revoking one
 * drops its open connections at once; it has to pair again with a new code.
 */
export function PairedDevices({ envId }: { envId: string | undefined }) {
  const ownClientId = useEnvironments((s) => s.environments.find((e) => e.id === (envId ?? s.primaryId))?.clientId);
  const [clients, setClients] = useState<PairedClient[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PairedClient | null>(null);

  const load = useCallback((): void => {
    call("env.clients.list", {}, envOpt(envId))
      .then((result) => {
        setClients(result.clients);
        setError(null);
      })
      .catch((err: unknown) => setError(errorText(err)));
  }, [envId]);

  useEffect(load, [load]);

  const revoke = (client: PairedClient): void => {
    setConfirm(null);
    call("env.clients.revoke", { id: client.id }, envOpt(envId))
      .then(load)
      .catch((err: unknown) => setError(errorText(err)));
  };

  const now = Date.now();
  return (
    <SettingRow
      label="Paired devices"
      help="Each device that paired holds its own token; revoke one you no longer use or have lost"
      extra={
        <>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          {clients !== null && clients.length === 0 ? <p className={styles.note}>No device has paired with this machine yet.</p> : null}
          {clients !== null && clients.length > 0 ? (
            <ul className={styles.list} aria-label="Paired devices">
              {clients.map((client) => (
                <li key={client.id} className={styles.row}>
                  <span className={styles.name}>
                    {client.name}
                    {client.id === ownClientId ? (
                      <Pill size="sm" tone="accent">
                        this device
                      </Pill>
                    ) : null}
                  </span>
                  <span className={styles.meta} title={client.lastAddress}>
                    paired {day(client.createdAt)} · {client.lastSeenAt === undefined ? "never seen" : `seen ${relativeTime(client.lastSeenAt, now)}`}
                  </span>
                  <Button variant="quietDanger" aria-label={`Revoke ${client.name}`} onClick={() => setConfirm(client)}>
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {confirm ? (
            <ConfirmDialog
              title={`Revoke “${confirm.name}”?`}
              body={
                confirm.id === ownClientId
                  ? "This is the device you are using: it disconnects now and has to pair again with a new code."
                  : "Its open connections close now. To use Tide from it again, pair it with a new code."
              }
              confirmLabel="Revoke"
              danger
              onConfirm={() => revoke(confirm)}
              onCancel={() => setConfirm(null)}
            />
          ) : null}
        </>
      }
    />
  );
}
