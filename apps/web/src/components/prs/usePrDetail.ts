import { useCallback, useEffect, useState } from "react";
import type { DiffResult, PrDetail } from "@tide/contracts";
import { call } from "../../state/model.ts";
import { errorText } from "../../lib/dispatchOrToast.ts";
import { routeOf, type PrEntry } from "./prData.ts";

export type Load<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; data: T };

/** `pr.detail` for the open PR, routed to its environment; `reload` after an action. */
export function usePrDetail(entry: PrEntry): { load: Load<PrDetail>; reload: () => void } {
  const [load, setLoad] = useState<Load<PrDetail>>({ state: "loading" });
  const [tick, setTick] = useState(0);
  const { projectId, envId } = entry;
  const number = entry.pr.number;
  useEffect(() => {
    let alive = true;
    const opts = routeOf({ ...(envId === undefined ? {} : { envId }) });
    const params = { projectId, number };
    (opts ? call("pr.detail", params, opts) : call("pr.detail", params))
      .then((data) => {
        if (alive) setLoad({ state: "ok", data });
      })
      .catch((error: unknown) => {
        if (alive) setLoad({ state: "error", message: errorText(error) });
      });
    return () => {
      alive = false;
    };
  }, [projectId, number, envId, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { load, reload };
}

/** `pr.diff`, fetched only once the Files tab is opened. */
export function usePrDiff(entry: PrEntry, enabled: boolean): Load<DiffResult> | undefined {
  const [load, setLoad] = useState<Load<DiffResult> | undefined>(undefined);
  const { projectId, envId } = entry;
  const number = entry.pr.number;
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setLoad({ state: "loading" });
    const opts = routeOf({ ...(envId === undefined ? {} : { envId }) });
    const params = { projectId, number };
    (opts ? call("pr.diff", params, opts) : call("pr.diff", params))
      .then((data) => {
        if (alive) setLoad({ state: "ok", data });
      })
      .catch((error: unknown) => {
        if (alive) setLoad({ state: "error", message: errorText(error) });
      });
    return () => {
      alive = false;
    };
  }, [projectId, number, envId, enabled]);
  return load;
}
