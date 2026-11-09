import { useEffect, useState } from "react";
import type { DiscoveredPeer } from "@tide/contracts";
import { call } from "../../state/model.ts";
import { useEnvironments } from "../../state/environments.ts";
import styles from "./DiscoveredList.module.css";

/**
 * R17: Tide servers the primary machine found on its LAN over mDNS. Picking one prefills the
 * URL; the code still has to come from that machine. Renders nothing when the browse found no
 * one new, is off on that host, or the server is too old to know `env.discover`.
 */
export function DiscoveredList({ onPick }: { onPick: (url: string) => void }) {
  const [peers, setPeers] = useState<DiscoveredPeer[]>([]);
  const known = useEnvironments((s) => s.environments);

  useEffect(() => {
    let live = true;
    call("env.discover", {})
      .then((result) => {
        if (live && result.enabled) setPeers(result.peers);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const fresh = peers.filter((p) => !known.some((e) => e.id === p.environmentId));
  if (fresh.length === 0) return null;
  return (
    <section className={styles.found} aria-label="Found on your network">
      <h3 className={styles.heading}>Found on your network</h3>
      <ul className={styles.list}>
        {fresh.map((peer) => {
          const url = peer.urls[0] ?? `http://${peer.host}:${peer.port}`;
          return (
            <li key={peer.environmentId}>
              <button type="button" className={styles.row} onClick={() => onPick(url)} aria-label={`Use ${peer.name}`}>
                <span className={styles.name}>{peer.name}</span>
                <span className={styles.meta}>
                  {peer.host.includes(":") ? `[${peer.host}]` : peer.host}:{peer.port}
                  {peer.version.length > 0 ? ` · v${peer.version}` : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
