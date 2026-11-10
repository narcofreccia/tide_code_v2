import { useEffect, useState, type ReactNode } from "react";
import { resolveServerUrl } from "../../lib/bootstrap.ts";
import { retryPrimary } from "../../state/envManager.ts";
import { useEnvironments } from "../../state/envStore.ts";
import { useModel } from "../../state/model.ts";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { BootActions, buildReport } from "./ErrorBoundary.tsx";
import { ReconnectBanner, UnauthorizedBanner } from "./ReconnectBanner.tsx";
import styles from "./BootScreen.module.css";

export const BOOT_TIMEOUT_MS = 8000;

/**
 * Renders the app immediately and lays connection states over it:
 *
 * - never connected in this page's life and still not open 8 s after mount: the full
 *   "Could not reach the Tide server" screen (boot failure). It lifts if the connection opens.
 * - the primary refused the token (`unauthorized`, terminal): a specific full screen, which
 *   the user may dismiss to look around; a quiet line then stays until it is resolved.
 * - connected before, now dropped: no overlay; a calm "Reconnecting…" pill after 2 s
 *   (`ReconnectBanner`), lifted by itself when the connection is back.
 */
export function BootGate({ children }: { children: ReactNode }) {
  const status = useModel((s) => s.status);
  const lastError = useModel((s) => s.lastError);
  const unauthorized = useEnvironments((s) => s.primaryId !== undefined && s.statuses[s.primaryId]?.connection === "unauthorized");
  const managed = useEnvironments((s) => s.primaryId !== undefined);
  const [expired, setExpired] = useState(false);
  const [everOpen, setEverOpen] = useState(status === "open");
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setExpired(true), BOOT_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, []);
  useEffect(() => {
    if (status === "open") setEverOpen(true);
  }, [status]);
  useEffect(() => {
    if (!unauthorized) setDismissed(false);
  }, [unauthorized]);
  const opened = everOpen || status === "open";

  let overlay: ReactNode = null;
  if (unauthorized && !dismissed) overlay = <UnauthorizedScreen lastError={lastError} onDismiss={() => setDismissed(true)} />;
  else if (unauthorized) overlay = <UnauthorizedBanner />;
  else if (!opened && expired) overlay = <UnreachableScreen status={status} lastError={lastError} />;
  else if (opened && status !== "open") overlay = <ReconnectBanner onRetry={managed ? retryPrimary : undefined} />;

  return (
    <>
      {children}
      {overlay}
    </>
  );
}

function UnreachableScreen({ status, lastError }: { status: string; lastError: string | null }) {
  const url = resolveServerUrl();
  return (
    <div className={styles.screen} role="alert">
      <Card header="Could not reach the Tide server">
        <p className={styles.message}>{url}</p>
        <p className={styles.hint}>
          Connection: {status}
          {lastError ? ` (${String(lastError)})` : ""}. Start the server, or check the address. A remote server needs a token:
          open the page with ?token=… or set VITE_TIDE_TOKEN.
        </p>
        <BootActions
          retryLabel="Retry"
          report={() => buildReport("server unreachable", lastError ? String(lastError) : "no error recorded", [`Server: ${url}`, `Status: ${status}`])}
        />
      </Card>
    </div>
  );
}

function UnauthorizedScreen({ lastError, onDismiss }: { lastError: string | null; onDismiss: () => void }) {
  const url = resolveServerUrl();
  return (
    <div className={styles.screen} role="alert">
      <Card header="The server refused this device">
        <p className={styles.message}>{url}</p>
        <p className={styles.hint}>
          Its token is wrong or was revoked. Pair this device again (Settings › Environments), or open the page with a valid
          ?token=…. Retrying with the same token cannot work.
        </p>
        <BootActions
          retryLabel="Reload"
          report={() => buildReport("unauthorized", lastError ? String(lastError) : "token refused", [`Server: ${url}`])}
        />
        <div className={styles.actions}>
          <Button variant="quiet" onClick={onDismiss}>
            Continue without a connection
          </Button>
        </div>
      </Card>
    </div>
  );
}
