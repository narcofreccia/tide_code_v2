import { useCallback, useEffect, useState } from "react";
import type { DeviceAccess, PairedClient } from "@tide/contracts";
import { call } from "../../state/model.ts";
import { useEnvironments } from "../../state/environments.ts";
import { errorText } from "../../lib/dispatchOrToast.ts";
import { relativeTime } from "../../lib/relativeTime.ts";
import { Button } from "../ui/Button.tsx";
import { ConfirmDialog } from "../ui/Dialog.tsx";
import { Pill } from "../ui/Pill.tsx";
import { Select, type SelectOption } from "../ui/Select.tsx";
import { showToast } from "../../state/toast.ts";
import { SettingRow } from "../settings/ui/SettingRow.tsx";
import { envOpt } from "./envView.ts";
import styles from "./PairedDevices.module.css";

/**
 * R18: true when this client reaches the environment with the master token (the local machine, or
 * a client paired before per-device tokens). A paired device (`clientId` set) cannot mint pairing
 * codes, revoke other devices or change how the machine is exposed: the server answers `forbidden`.
 */
export function useOwnsEnvironment(envId: string | undefined): boolean {
  return useEnvironments((s) => s.environments.find((e) => e.id === (envId ?? s.primaryId))?.clientId === undefined);
}

/** The server refused the call because this connection is a paired device, not the owner. */
export const isForbidden = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === "forbidden";

/** R19: a row written before access levels (or an older server) has full access. */
export const accessOf = (client: PairedClient): DeviceAccess => client.access ?? "full";

export const ACCESS_LABELS: Record<DeviceAccess, string> = { limited: "Limited", full: "Full access" };

const ACCESS_OPTIONS: SelectOption<DeviceAccess>[] = [
  { value: "limited", label: ACCESS_LABELS.limited, description: "Read, chat, approvals, review and merge" },
  { value: "full", label: ACCESS_LABELS.full, description: "Also terminal, file edits, settings, projects and Full access mode" },
];

const day = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/**
 * R17: the devices that paired with this machine, each holding its own token. Revoking one
 * drops its open connections at once; it has to pair again with a new code. R18: on a paired
 * device the server lists only that device, which may unpair itself; a `forbidden` answer (an
 * older or stricter server) hides the row instead of showing an error.
 */
export function PairedDevices({ envId }: { envId: string | undefined }) {
  const ownClientId = useEnvironments((s) => s.environments.find((e) => e.id === (envId ?? s.primaryId))?.clientId);
  const owner = ownClientId === undefined;
  const [hidden, setHidden] = useState(false);
  const [clients, setClients] = useState<PairedClient[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PairedClient | null>(null);

  const load = useCallback((): void => {
    call("env.clients.list", {}, envOpt(envId))
      .then((result) => {
        setClients(result.clients);
        setError(null);
      })
      .catch((err: unknown) => (isForbidden(err) ? setHidden(true) : setError(errorText(err))));
  }, [envId]);

  useEffect(load, [load]);

  // R19: optimistic; a refusal puts the list back from the server and says why
  const setAccess = (client: PairedClient, access: DeviceAccess): void => {
    if (accessOf(client) === access) return;
    setClients((list) => list?.map((c) => (c.id === client.id ? { ...c, access } : c)) ?? null);
    const failed = (why: string): void => {
      showToast(`Changing access for “${client.name}” failed: ${why}`);
      load();
    };
    call("env.clients.setAccess", { id: client.id, access }, envOpt(envId))
      .then((result) => (result.ok ? undefined : failed("that device is no longer paired")))
      .catch((err: unknown) => failed(isForbidden(err) ? "only the owner of the machine can change it" : errorText(err)));
  };

  const revoke = (client: PairedClient): void => {
    setConfirm(null);
    call("env.clients.revoke", { id: client.id }, envOpt(envId))
      .then(load)
      .catch((err: unknown) => (isForbidden(err) ? setHidden(true) : setError(errorText(err))));
  };

  if (hidden) return null;
  const now = Date.now();
  return (
    <SettingRow
      label={owner ? "Paired devices" : "This device"}
      help={
        owner
          ? "Each device that paired holds its own token. Limited devices cannot use the terminal, edit files, settings or projects; revoke one you no longer use or have lost"
          : "This device is paired with that machine; other devices are managed on the machine itself"
      }
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
                  {owner ? (
                    <Select
                      label={`Access for ${client.name}`}
                      value={accessOf(client)}
                      options={ACCESS_OPTIONS}
                      onSelect={(access) => setAccess(client, access)}
                      align="end"
                    />
                  ) : (
                    <Pill size="sm" tone={accessOf(client) === "full" ? "accent" : "muted"} title="Changed by the owner, on that machine">
                      {ACCESS_LABELS[accessOf(client)]}
                    </Pill>
                  )}
                  {owner || client.id === ownClientId ? (
                    <Button variant="quietDanger" aria-label={`Revoke ${client.name}`} onClick={() => setConfirm(client)}>
                      Revoke
                    </Button>
                  ) : null}
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
