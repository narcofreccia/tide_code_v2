import { useEffect, useState } from "react";
import type { DeviceAccess } from "@tide/contracts";
import { call } from "../../state/model.ts";
import { errorText } from "../../lib/dispatchOrToast.ts";
import { copyText } from "../../lib/threadActions.ts";
import { envOpt } from "./envView.ts";
import { isForbidden, useOwnsEnvironment } from "./PairedDevices.tsx";
import { NotEncrypted } from "./NotEncrypted.tsx";
import { Button } from "../ui/Button.tsx";
import { SettingRow } from "../settings/ui/SettingRow.tsx";
import { SettingToggle } from "../settings/ui/SettingToggle.tsx";
import styles from "./Environments.module.css";

interface Pairing {
  code: string;
  expiresAt: number;
  urls: string[];
  /** R19: the level this code pairs a device with */
  access: DeviceAccess;
}

/** R19: what the switch adds; one sentence under it. */
export const FULL_ACCESS_HELP = "Full access adds the terminal, file edits, settings, projects and Full access mode. Off, the device can read, chat, answer approvals, review and merge.";

/** "4:59" until the code expires. */
export function countdown(expiresAt: number, now: number): string {
  const left = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/**
 * "Pair another device": a single-use 6-digit code (5 minutes) the other device exchanges
 * for this machine's token. The token itself never leaves this screen.
 */
export function PairDevice({ envId }: { envId: string | undefined }) {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const owner = useOwnsEnvironment(envId);
  const [refused, setRefused] = useState(false);
  // R19: new devices pair with limited access unless the owner turns this on first
  const [full, setFull] = useState(false);
  const now = useNow(pairing !== null);
  const expired = pairing !== null && now >= pairing.expiresAt;

  const request = (fullAccess: boolean = full): void => {
    const access: DeviceAccess = fullAccess ? "full" : "limited";
    setBusy(true);
    setError(null);
    call("env.pairingCode", { access }, envOpt(envId))
      .then((result) => setPairing({ ...result, access }))
      .catch((err: unknown) => (isForbidden(err) ? setRefused(true) : setError(errorText(err))))
      .finally(() => setBusy(false));
  };

  // a code already on screen is for the old level: swap it for one with the new level
  const toggle = (next: boolean): void => {
    setFull(next);
    if (pairing !== null) request(next);
  };

  // R18: only the owner (master token) may mint pairing codes; a paired device sees no button
  if (!owner || refused) return null;
  return (
    <>
      <SettingRow
        label="Full access"
        help={FULL_ACCESS_HELP}
        control={(id) => <SettingToggle id={id} checked={full} disabled={busy} onChange={toggle} />}
      />
      <SettingRow
        label="Pair another device"
        help="A one-time 6-digit code another device exchanges for this machine's token"
        control={
          <Button variant={pairing && !expired ? "quiet" : "primary"} disabled={busy} onClick={() => request()}>
            {pairing ? "New code" : "Pair another device"}
          </Button>
        }
        extra={
          error || pairing ? (
            <>
              {error ? <p className={styles.error} role="alert">{error}</p> : null}
              {pairing ? (
                <div className={styles.pairBody} aria-label="Pairing code">
                  <span className={`${styles.pairCode} ${expired ? styles.expired : ""}`} data-testid="pairing-code">
                    {pairing.code}
                  </span>
                  <span className={styles.note}>
                    {expired ? "Expired — ask for a new code." : `Expires in ${countdown(pairing.expiresAt, now)} · works once`} ·{" "}
                    {pairing.access === "full" ? "pairs with full access" : "pairs with limited access"}
                  </span>
                  {pairing.urls.length > 0 ? (
                    <ul className={styles.urls} aria-label="Pairing URLs">
                      {pairing.urls.map((url) => (
                        <li key={url} className={styles.urlRow}>
                          <span className={styles.value}>{url}</span>
                          <NotEncrypted url={url} />
                          <Button variant="quiet" onClick={() => void copyText(url, "URL")}>
                            Copy
                          </Button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className={styles.note}>
                      This server only listens on localhost. Start it with <span className={styles.code}>--host 0.0.0.0</span> (or
                      put it on Tailscale) so the other device can reach it.
                    </p>
                  )}
                  <p className={styles.note}>
                    On the other device open Tide → Settings → Environments → Add machine, enter one of these URLs and this code.
                  </p>
                </div>
              ) : null}
            </>
          ) : undefined
        }
      />
    </>
  );
}
