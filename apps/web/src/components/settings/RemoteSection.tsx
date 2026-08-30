import { resolveServerUrl } from "../../lib/bootstrap.ts";
import { useServerInfo } from "../../lib/useServerInfo.ts";
import { useModel } from "../../state/model.ts";
import section from "./Section.module.css";

/** Read-only until remote access ships; shows what this client is talking to. */
export function RemoteSection() {
  const info = useServerInfo();
  const environmentId = useModel((s) => s.environmentId);
  const status = useModel((s) => s.status);

  return (
    <div className={section.section}>
      <div className={section.head}>
        <h3 className={section.title}>Remote</h3>
      </div>
      <ul className={section.rows}>
        <li className={section.row}>
          <span className={section.label}>Environment</span>
          <span className={section.value}>{info?.environmentId ?? environmentId ?? "—"}</span>
        </li>
        <li className={section.row}>
          <span className={section.label}>Server</span>
          <span className={section.value}>{resolveServerUrl()}</span>
        </li>
        <li className={section.row}>
          <span className={section.label}>Connection</span>
          <span className={section.value}>{status}</span>
        </li>
      </ul>
      <p className={section.note}>
        Tide already runs as a server plus a browser client, so the pieces for remote access are in
        place. Reaching this environment from another device — bearer pairing, Tailscale or an SSH
        tunnel — lands in a later phase; for now the server binds to localhost.
      </p>
    </div>
  );
}
