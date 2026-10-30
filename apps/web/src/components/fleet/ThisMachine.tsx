import type { ServerInfo } from "@tide/contracts";
import { patchServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { copyText } from "../../lib/threadActions.ts";
import { Button } from "../ui/Button.tsx";
import { SettingNote, SettingsGroup } from "../settings/ui/SettingsGroup.tsx";
import { SettingRow } from "../settings/ui/SettingRow.tsx";
import { SettingText } from "../settings/ui/SettingText.tsx";
import { HostBars } from "./FleetBits.tsx";
import { hostLine, harnessSummary, formatBytes } from "./envView.ts";
import { PairDevice } from "./PairDevice.tsx";
import { UpdateHarnesses } from "./UpdateHarnesses.tsx";
import styles from "./Environments.module.css";

const trim = (value: string): string => value.trim();

function Value({ children }: { children: React.ReactNode }) {
  return <span className={styles.value}>{children}</span>;
}

/**
 * The machine whose settings this screen edits (the primary environment): its name,
 * what it runs on, how other devices reach it, and the pairing / update actions.
 */
export function ThisMachine({ info, envId }: { info: ServerInfo | undefined; envId: string | undefined }) {
  const settings = useServerSettings((s) => s.settings.environment);
  const name = settings.name || info?.name || "";
  const lanUrls = info?.remote?.lanUrls ?? [];
  const host = info?.host;

  return (
    <SettingsGroup title="This machine" actions={host ? <HostBars host={host} /> : undefined}>
      <SettingRow
        label="Name"
        control={(id) => (
          <SettingText
            id={id}
            label="Machine name"
            value={name}
            placeholder={host?.hostname ?? "my-laptop"}
            normalize={trim}
            validate={(next) => (next === "" && name !== "" ? "A machine needs a name" : undefined)}
            onCommit={(next) => (next === "" ? undefined : patchServerSettings({ environment: { name: next } }))}
          />
        )}
      />
      <SettingRow label="Host" control={<Value>{hostLine(host)}</Value>} />
      {host ? (
        <SettingRow
          label="Memory"
          help="In use counts what the OS could not hand out right now; file cache is available"
          control={
            <Value>
              {formatBytes(host.memTotal - host.memFree)} in use · {formatBytes(host.memFree)} available of {formatBytes(host.memTotal)}
            </Value>
          }
        />
      ) : null}
      <SettingRow label="Tide" control={<Value>{info?.version ?? "—"}</Value>} />
      <SettingRow label="Harnesses" control={<Value>{harnessSummary(info)}</Value>} />
      <SettingRow
        label="SSH host for editors"
        help="Lets “Open in VS Code / Cursor” reach this machine from another computer"
        control={(id) => (
          <SettingText
            id={id}
            label="SSH host"
            mono
            value={settings.sshHost ?? info?.sshHost ?? ""}
            placeholder="user@host"
            normalize={trim}
            onCommit={(next) => patchServerSettings({ environment: { sshHost: next === "" ? null : next } })}
          />
        )}
      />
      {lanUrls.length > 0 ? (
        <SettingRow
          label="LAN URLs"
          help="Devices on your network reach this machine here"
          extra={
            <ul className={styles.urls} aria-label="LAN URLs">
              {lanUrls.map((url) => (
                <li key={url} className={styles.urlRow}>
                  <Value>{url}</Value>
                  <Button variant="quiet" onClick={() => void copyText(url, "LAN URL")}>
                    Copy
                  </Button>
                </li>
              ))}
            </ul>
          }
        />
      ) : (
        <SettingNote>
          Reachable only from this computer. Start the server with <span className={styles.code}>tide-server --host 0.0.0.0</span>{" "}
          to reach it from your network.
        </SettingNote>
      )}
      <PairDevice envId={envId} />
      <UpdateHarnesses />
    </SettingsGroup>
  );
}
