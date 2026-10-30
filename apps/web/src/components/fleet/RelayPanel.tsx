import { useState } from "react";
import type { ServerInfo } from "@tide/contracts";
import { patchServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { Button } from "../ui/Button.tsx";
import section from "../settings/Section.module.css";
import styles from "./Environments.module.css";

/**
 * Optional self-hosted relay this machine dials out to, for reaching it without a VPN or an
 * open port. Collapsed by default: most setups never need it.
 */
export function RelayPanel({ info }: { info: ServerInfo | undefined }) {
  const relay = useServerSettings((s) => s.settings.relay);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(relay?.url ?? "");
  const [key, setKey] = useState("");
  const live = info?.relay;
  const state = relay === undefined ? "off" : live?.connected ? "connected" : "not connected";

  return (
    <section className={section.section} aria-label="Relay">
      <div className={section.head}>
        <button type="button" className={styles.fold} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"} Relay
          <span className={styles.foldSummary}>{state}</span>
        </button>
      </div>
      {open ? (
        <>
          <p className={section.note}>
            The relay only carries bytes between this machine and your devices, so you need no VPN or open port.
            Every client still authenticates to this machine with its own token, exactly as on the LAN.
          </p>
          {live?.clientUrl ? (
            <p className={section.note}>
              Clients connect through <span className={section.code}>{live.clientUrl}</span>
            </p>
          ) : null}
          <form
            className={section.form}
            aria-label="Relay settings"
            onSubmit={(e) => {
              e.preventDefault();
              const target = url.trim();
              if (target === "") return;
              void patchServerSettings({ relay: { url: target, ...(key.trim() === "" ? {} : { key: key.trim() }) } });
              setKey("");
            }}
          >
            <div className={section.formRow}>
              <input
                className={section.input}
                aria-label="Relay URL"
                placeholder="wss://relay.example.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div className={section.formRow}>
              <input
                className={section.input}
                type="password"
                autoComplete="off"
                aria-label="Relay key"
                placeholder={relay?.hasKey ? "key stored — type to replace" : "relay key"}
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              <Button type="submit" variant="primary" disabled={url.trim() === ""}>
                {relay ? "Save" : "Connect"}
              </Button>
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
            </div>
          </form>
        </>
      ) : null}
    </section>
  );
}
