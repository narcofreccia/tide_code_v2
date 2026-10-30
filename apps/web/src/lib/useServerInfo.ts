import { useEffect, useState } from "react";
import type { RpcOutput } from "@tide/contracts";
import { useEnvironments } from "../state/envStore.ts";
import { call } from "../state/model.ts";

export type ServerInfo = RpcOutput<"server.info">;

/**
 * `server.info` of an environment (default: the primary). R9: the connection manager
 * refreshes it every 30 s into `useEnvironments().statuses[id].info`; this hook reads that
 * and only asks the server itself when nothing is cached yet (single-server mode, tests).
 */
export function useServerInfo(envId?: string): ServerInfo | undefined {
  const id = useEnvironments((s) => envId ?? s.primaryId);
  const live = useEnvironments((s) => (id === undefined ? undefined : s.statuses[id]?.info));
  const [fetched, setFetched] = useState<ServerInfo>();
  const missing = live === undefined;
  useEffect(() => {
    if (!missing) return;
    let alive = true;
    (envId === undefined ? call("server.info", {}) : call("server.info", {}, { envId }))
      .then((result) => {
        if (alive) setFetched(result);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [envId, missing]);
  return live ?? fetched;
}
