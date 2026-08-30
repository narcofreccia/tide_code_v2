import { useEffect, useState } from "react";
import type { RpcOutput } from "@tide/contracts";
import { call } from "../state/model.ts";

export type ServerInfo = RpcOutput<"server.info">;

/** One `server.info` read per mount; Settings › Remote and About are the only callers. */
export function useServerInfo(): ServerInfo | undefined {
  const [info, setInfo] = useState<ServerInfo>();
  useEffect(() => {
    let live = true;
    call("server.info", {})
      .then((result) => {
        if (live) setInfo(result);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return info;
}
