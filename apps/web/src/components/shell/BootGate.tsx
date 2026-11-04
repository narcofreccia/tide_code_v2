import { useEffect, useState, type ReactNode } from "react";
import { resolveServerUrl } from "../../lib/bootstrap.ts";
import { useModel } from "../../state/model.ts";
import { Card } from "../ui/Card.tsx";
import { BootActions, buildReport } from "./ErrorBoundary.tsx";
import styles from "./BootScreen.module.css";

export const BOOT_TIMEOUT_MS = 8000;

/**
 * Renders the app immediately; if the server connection is not open 8 s after mount it
 * lays a failed screen over it (server URL, token hint, Retry, Copy report). The screen
 * lifts by itself if the connection opens later.
 */
export function BootGate({ children }: { children: ReactNode }) {
  const status = useModel((s) => s.status);
  const lastError = useModel((s) => s.lastError);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setExpired(true), BOOT_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, []);
  const failed = expired && status !== "open";
  const url = failed ? resolveServerUrl() : "";
  return (
    <>
      {children}
      {failed ? (
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
      ) : null}
    </>
  );
}
