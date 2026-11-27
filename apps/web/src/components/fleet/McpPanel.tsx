import { useState } from "react";
import type { RpcOutput, ServerInfo } from "@tide/contracts";
import { call } from "../../state/model.ts";
import { errorText } from "../../lib/dispatchOrToast.ts";
import { copyText } from "../../lib/threadActions.ts";
import { Button } from "../ui/Button.tsx";
import { Pill } from "../ui/Pill.tsx";
import { SettingNote, SettingsGroup } from "../settings/ui/SettingsGroup.tsx";
import { SettingRow } from "../settings/ui/SettingRow.tsx";
import { envOpt } from "./envView.ts";
import { isForbidden, useOwnsEnvironment } from "./PairedDevices.tsx";
import styles from "./Environments.module.css";

type McpCredentials = RpcOutput<"env.mcpCredentials">;

const maskSecret = (value: string): string => (value.length <= 8 ? "••••••••" : `${value.slice(0, 4)}••••••••••••${value.slice(-4)}`);

/**
 * Owner-only panel for grabbing the Environment ID, revocable MCP Bearer token, and 2FA elevation
 * secret needed to connect Tide AI Chat (or another remote MCP client) without using the CLI.
 */
export function McpPanel({ info, envId }: { info: ServerInfo | undefined; envId?: string | undefined }) {
  const owner = useOwnsEnvironment(envId);
  const [creds, setCreds] = useState<McpCredentials | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [revealToken, setRevealToken] = useState(false);
  const [revealSecret, setRevealSecret] = useState(false);

  const environmentId = creds?.environmentId ?? info?.environmentId;
  const relayConnected = info?.relay?.connected === true;

  const generate = (): void => {
    setBusy(true);
    setError(null);
    call("env.mcpCredentials", {}, envOpt(envId))
      .then((result) => {
        setCreds(result);
        setRevealToken(false);
        setRevealSecret(false);
      })
      .catch((err: unknown) => (isForbidden(err) ? setRefused(true) : setError(errorText(err))))
      .finally(() => setBusy(false));
  };

  return (
    <SettingsGroup
      title="Remote MCP"
      collapsible
      actions={
        <Pill size="sm" tone={relayConnected ? "ok" : "muted"}>
          {relayConnected ? "relay ready" : "setup"}
        </Pill>
      }
    >
      <SettingNote>
        Connect Tide AI Chat (or another remote MCP client) to this machine over the relay. Paste the Environment ID,
        MCP Bearer token, and elevation secret into Tide AI Chat → Connectors → Tide Code, then paste the Relay URL
        and key from Tide AI Chat into the Relay section above.
      </SettingNote>
      {environmentId ? (
        <SettingRow
          label="Environment ID"
          help="Identifies this machine on the relay"
          extra={
            <div className={styles.urlRow}>
              <span className={styles.value} data-testid="mcp-environment-id">
                {environmentId}
              </span>
              <Button variant="quiet" onClick={() => void copyText(environmentId, "Environment ID")}>
                Copy
              </Button>
            </div>
          }
        />
      ) : null}
      {!owner || refused ? (
        <SettingNote>Only the owner of this machine can generate remote MCP credentials.</SettingNote>
      ) : (
        <>
          <SettingRow
            label="MCP credentials"
            help="Mints a revocable MCP-only Bearer token (listed under Paired devices) and returns this machine's 2FA elevation secret"
            control={
              <Button variant={creds ? "quiet" : "primary"} disabled={busy} onClick={generate}>
                {busy ? "Generating…" : creds ? "Generate new token" : "Generate credentials"}
              </Button>
            }
            extra={error ? <p className={styles.error} role="alert">{error}</p> : undefined}
          />
          {creds ? (
            <>
              <SettingRow
                label="MCP Bearer token"
                help="Shown once — revoke it anytime under Paired devices (Tide AI Chat MCP)"
                extra={
                  <div className={styles.urlRow}>
                    <span className={styles.value} data-testid="mcp-bearer-token">
                      {revealToken ? creds.token : maskSecret(creds.token)}
                    </span>
                    <div className={styles.cardActions}>
                      <Button variant="quiet" onClick={() => setRevealToken((prev) => !prev)}>
                        {revealToken ? "Hide" : "Show"}
                      </Button>
                      <Button variant="quiet" onClick={() => void copyText(creds.token, "MCP Bearer token")}>
                        Copy
                      </Button>
                    </div>
                  </div>
                }
              />
              <SettingRow
                label="Elevation secret"
                help="Shared HMAC secret for 2FA step-up full-access leases"
                extra={
                  <div className={styles.urlRow}>
                    <span className={styles.value} data-testid="mcp-elevation-secret">
                      {revealSecret ? creds.elevationSecret : maskSecret(creds.elevationSecret)}
                    </span>
                    <div className={styles.cardActions}>
                      <Button variant="quiet" onClick={() => setRevealSecret((prev) => !prev)}>
                        {revealSecret ? "Hide" : "Show"}
                      </Button>
                      <Button variant="quiet" onClick={() => void copyText(creds.elevationSecret, "Elevation secret")}>
                        Copy
                      </Button>
                    </div>
                  </div>
                }
              />
            </>
          ) : null}
        </>
      )}
    </SettingsGroup>
  );
}
