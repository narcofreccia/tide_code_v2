import { useEffect } from "react";
import { useWindowReturn } from "../lib/useWindowReturn.ts";
import { envFor } from "./envManager.ts";
import { useEnvironments } from "./envStore.ts";
import { call, setRpcErrorObserver } from "./model.ts";

/**
 * R19: this device's access level on each machine comes from that machine's cached `server.info`
 * (`ServerInfo.access`), which the connection re-reads every 30 s. When the owner changes the
 * level, two moments pick it up at once instead: a call the server answers `forbidden` (the
 * cached level may be stale), and the user coming back to the window (they may have just turned
 * Full access on at the machine). Only paired devices carry a level; the owner's info has none.
 */

const inFlight = new Map<string, Promise<void>>();

/** Re-reads `server.info` of one environment into its cached status; one request at a time per machine. */
export function refreshServerInfo(envId: string): Promise<void> {
  const pending = inFlight.get(envId);
  if (pending) return pending;
  const run = call("server.info", {}, { envId })
    .then((info) => {
      useEnvironments.setState((s) => {
        const status = s.statuses[envId];
        if (status === undefined || info.environmentId !== envId) return s;
        return { statuses: { ...s.statuses, [envId]: { ...status, info } } };
      });
    })
    .catch(() => undefined)
    .finally(() => inFlight.delete(envId));
  inFlight.set(envId, run);
  return run;
}

const isForbidden = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "forbidden";

/** The machines where this device has a level (connected, and the server reported one). */
function leveledEnvs(): string[] {
  const { statuses } = useEnvironments.getState();
  return Object.entries(statuses)
    .filter(([, status]) => status.connection === "connected" && status.info?.access !== undefined)
    .map(([id]) => id);
}

/** Mounted once by the app shell. */
export function useDeviceAccessRefresh(): void {
  useEffect(() => {
    setRpcErrorObserver((subject, opts, error) => {
      if (!isForbidden(error)) return;
      const envId = envFor(subject, opts);
      if (envId !== undefined) void refreshServerInfo(envId);
    });
    return () => setRpcErrorObserver(undefined);
  }, []);
  useWindowReturn(() => {
    for (const id of leveledEnvs()) void refreshServerInfo(id);
  });
}
