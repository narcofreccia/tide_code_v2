import { resolveServerUrl } from "../../lib/bootstrap.ts";
import { useServerInfo } from "../../lib/useServerInfo.ts";
import { useModel } from "../../state/model.ts";
import { showToast } from "../../state/toast.ts";
import { Button } from "../ui/Button.tsx";
import section from "./Section.module.css";

async function copy(value: string, what: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(value);
  } catch {
    /* clipboard may be denied; the toast still names what was copied */
  }
  showToast(`Copied ${what}`);
}

/** Read-only: what this client talks to and how another device reaches it. */
export function RemoteSection() {
  const info = useServerInfo();
  const environmentId = useModel((s) => s.environmentId);
  const status = useModel((s) => s.status);
  const remote = info?.remote;
  const pairingUrl = remote?.pairingUrl;

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
          <span className={section.label}>Bound to</span>
          <span className={section.value}>{remote ? `${remote.host}:${remote.port}` : "—"}</span>
        </li>
        <li className={section.row}>
          <span className={section.label}>Connection</span>
          <span className={section.value}>{status}</span>
        </li>
      </ul>

      <div className={section.head}>
        <h3 className={section.title}>LAN URLs</h3>
      </div>
      {remote && remote.lanUrls.length > 0 ? (
        <ul className={section.rows} aria-label="LAN URLs">
          {remote.lanUrls.map((url) => (
            <li key={url} className={section.row}>
              <span className={section.value}>{url}</span>
              <Button variant="quiet" onClick={() => void copy(url, "LAN URL")}>
                Copy
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={section.note}>
          No LAN address. The server is bound to localhost — start it with{" "}
          <span className={section.code}>tide-server --host 0.0.0.0</span> to reach it from another
          device on your network.
        </p>
      )}

      {pairingUrl ? (
        <>
          <div className={section.head}>
            <h3 className={section.title}>Pairing URL</h3>
            <Button variant="quiet" onClick={() => void copy(pairingUrl, "pairing URL")}>
              Copy
            </Button>
          </div>
          <p className={section.note}>
            <span className={section.code}>{pairingUrl}</span>
          </p>
          <p className={section.note}>
            This URL contains your server token — share only with your own devices.
          </p>
        </>
      ) : null}

      <p className={section.note}>
        <strong>Tailscale</strong> — the safest way in from outside the LAN: run{" "}
        <span className={section.code}>tailscale serve 3777</span> on this host and open the printed{" "}
        <span className={section.code}>*.ts.net</span> URL from any device on your tailnet.
      </p>
      <p className={section.note}>
        <strong>SSH port-forward</strong> — no exposure at all:{" "}
        <span className={section.code}>ssh -L 3777:127.0.0.1:3777 host</span>, then open{" "}
        <span className={section.code}>http://127.0.0.1:3777</span> locally.
      </p>
      <p className={section.note}>
        Binding beyond localhost is a server flag (<span className={section.code}>--host 0.0.0.0</span>
        ), never something a client can flip.
      </p>
    </div>
  );
}
