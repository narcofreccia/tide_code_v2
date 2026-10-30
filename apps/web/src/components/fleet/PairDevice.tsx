import { useEffect, useState } from "react";
import { call } from "../../state/model.ts";
import { errorText } from "../../lib/dispatchOrToast.ts";
import { copyText } from "../../lib/threadActions.ts";
import { envOpt } from "./envView.ts";
import { Button } from "../ui/Button.tsx";
import section from "../settings/Section.module.css";
import styles from "./Environments.module.css";

interface Pairing {
  code: string;
  expiresAt: number;
  urls: string[];
}

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
  const now = useNow(pairing !== null);
  const expired = pairing !== null && now >= pairing.expiresAt;

  const request = (): void => {
    setBusy(true);
    setError(null);
    call("env.pairingCode", {}, envOpt(envId))
      .then((result) => setPairing(result))
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className={styles.pair}>
      <div className={section.head}>
        <span className={styles.subTitle}>Pair another device</span>
        <Button variant={pairing && !expired ? "quiet" : "primary"} disabled={busy} onClick={request}>
          {pairing ? "New code" : "Pair another device"}
        </Button>
      </div>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {pairing ? (
        <div className={styles.pairBody} aria-label="Pairing code">
          <span className={`${styles.code} ${expired ? styles.expired : ""}`} data-testid="pairing-code">
            {pairing.code}
          </span>
          <span className={section.note}>
            {expired ? "Expired — ask for a new code." : `Expires in ${countdown(pairing.expiresAt, now)} · works once`}
          </span>
          {pairing.urls.length > 0 ? (
            <ul className={styles.urls} aria-label="Pairing URLs">
              {pairing.urls.map((url) => (
                <li key={url} className={styles.urlRow}>
                  <span className={section.value}>{url}</span>
                  <Button variant="quiet" onClick={() => void copyText(url, "URL")}>
                    Copy
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={section.note}>
              This server only listens on localhost. Start it with <span className={section.code}>--host 0.0.0.0</span> (or
              put it on Tailscale) so the other device can reach it.
            </p>
          )}
          <p className={section.note}>
            On the other device open Tide → Settings → Environments → Add machine, enter one of these URLs and this code.
          </p>
        </div>
      ) : null}
    </div>
  );
}
