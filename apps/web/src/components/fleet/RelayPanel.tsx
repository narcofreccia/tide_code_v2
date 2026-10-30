import { useState } from "react";
import type { ServerInfo } from "@tide/contracts";
import { patchServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { Button } from "../ui/Button.tsx";
import { Pill } from "../ui/Pill.tsx";
import { SettingNote, SettingsGroup } from "../settings/ui/SettingsGroup.tsx";
import { SettingRow } from "../settings/ui/SettingRow.tsx";
import styles from "./Environments.module.css";

/**
 * Optional self-hosted relay this machine dials out to, for reaching it without a VPN or an
 * open port. Collapsed by default: most setups never need it. URL and key save together.
 */
export function RelayPanel({ info }: { info: ServerInfo | undefined }) {
  const relay = useServerSettings((s) => s.settings.relay);
  const [url, setUrl] = useState(relay?.url ?? "");
  const [key, setKey] = useState("");
  const live = info?.relay;
  const state = relay === undefined ? "off" : live?.connected ? "connected" : "not connected";

  return (
    <SettingsGroup
      title="Relay"
      collapsible
      actions={
        <Pill size="sm" tone={state === "connected" ? "ok" : state === "off" ? "muted" : "needs"}>
          {state}
        </Pill>
      }
    >
      <SettingNote>
        The relay only carries bytes between this machine and your devices, so you need no VPN or open port. Every client
        still authenticates to this machine with its own token, exactly as on the LAN.
      </SettingNote>
      {live?.clientUrl ? (
        <SettingNote>
          Clients connect through <span className={styles.code}>{live.clientUrl}</span>
        </SettingNote>
      ) : null}
      <form
        className={styles.formRows}
        aria-label="Relay settings"
        onSubmit={(e) => {
          e.preventDefault();
          const target = url.trim();
          if (target === "") return;
          void patchServerSettings({ relay: { url: target, ...(key.trim() === "" ? {} : { key: key.trim() }) } });
          setKey("");
        }}
      >
        <SettingRow
          label="URL"
          control={(id) => (
            <input
              id={id}
              className={`${styles.input} ${styles.wideField}`}
              aria-label="Relay URL"
              placeholder="wss://relay.example.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          )}
        />
        <SettingRow
          label="Key"
          help={relay?.hasKey ? "A key is stored; type to replace it" : undefined}
          control={(id) => (
            <input
              id={id}
              className={`${styles.input} ${styles.wideField}`}
              type="password"
              autoComplete="off"
              aria-label="Relay key"
              placeholder={relay?.hasKey ? "key stored — type to replace" : "relay key"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          )}
        />
        <SettingRow
          label={relay ? "Save the URL and key, or stop dialing out" : "Dial out to this relay"}
          control={
            <>
              {relay ? (
                <Button
                  variant="quietDanger"
                  onClick={() => {
                    void patchServerSettings({ relay: null });
                    setUrl("");
                  }}
                >
                  Disconnect
                </Button>
              ) : null}
              <Button type="submit" variant="primary" disabled={url.trim() === ""}>
                {relay ? "Save" : "Connect"}
              </Button>
            </>
          }
        />
      </form>
    </SettingsGroup>
  );
}
