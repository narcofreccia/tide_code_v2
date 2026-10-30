import { useEffect, useState } from "react";
import type { ServerInfo } from "@tide/contracts";
import { patchServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { copyText } from "../../lib/threadActions.ts";
import { Button } from "../ui/Button.tsx";
import section from "../settings/Section.module.css";
import { HostBars } from "./FleetBits.tsx";
import { hostLine, harnessSummary, formatBytes } from "./envView.ts";
import { PairDevice } from "./PairDevice.tsx";
import { UpdateHarnesses } from "./UpdateHarnesses.tsx";
import styles from "./Environments.module.css";

/** A text setting that saves on Enter or when the field loses focus, never per keystroke. */
function SettingField({
  label,
  value,
  placeholder,
  onSave,
}: {
  label: string;
  value: string;
  placeholder: string;
  onSave: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (): void => {
    if (draft.trim() !== value) onSave(draft.trim());
  };
  return (
    <input
      className={section.input}
      aria-label={label}
      placeholder={placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          setDraft(value);
        }
      }}
    />
  );
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
    <section className={section.section} aria-label="This machine">
      <div className={section.head}>
        <h3 className={section.title}>This machine</h3>
        {host ? <HostBars host={host} /> : null}
      </div>
      <ul className={section.rows}>
        <li className={section.row}>
          <span className={section.label}>Name</span>
          <span className={styles.field}>
            <SettingField
              label="Machine name"
              value={name}
              placeholder={host?.hostname ?? "my-laptop"}
              onSave={(next) => {
                if (next !== "") void patchServerSettings({ environment: { name: next } });
              }}
            />
          </span>
        </li>
        <li className={section.row}>
          <span className={section.label}>Host</span>
          <span className={section.value}>{hostLine(host)}</span>
        </li>
        {host ? (
          <li className={section.row}>
            <span className={section.label}>Memory</span>
            <span className={section.value}>
              {formatBytes(host.memTotal - host.memFree)} of {formatBytes(host.memTotal)}
            </span>
          </li>
        ) : null}
        <li className={section.row}>
          <span className={section.label}>Tide</span>
          <span className={section.value}>{info?.version ?? "—"}</span>
        </li>
        <li className={section.row}>
          <span className={section.label}>Harnesses</span>
          <span className={section.value}>{harnessSummary(info)}</span>
        </li>
        <li className={section.row}>
          <span className={section.stack}>
            <span className={section.label}>SSH host for editors</span>
            <span className={section.secondary}>Lets “Open in VS Code / Cursor” reach this machine from another computer</span>
          </span>
          <span className={styles.field}>
            <SettingField
              label="SSH host"
              value={settings.sshHost ?? info?.sshHost ?? ""}
              placeholder="user@host"
              onSave={(next) => void patchServerSettings({ environment: { sshHost: next === "" ? null : next } })}
            />
          </span>
        </li>
      </ul>

      {lanUrls.length > 0 ? (
        <ul className={section.rows} aria-label="LAN URLs">
          {lanUrls.map((url) => (
            <li key={url} className={section.row}>
              <span className={section.value}>{url}</span>
              <Button variant="quiet" onClick={() => void copyText(url, "LAN URL")}>
                Copy
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={section.note}>
          Reachable only from this computer. Start the server with <span className={section.code}>tide-server --host 0.0.0.0</span>{" "}
          to reach it from your network.
        </p>
      )}

      <PairDevice envId={envId} />
      <UpdateHarnesses />
    </section>
  );
}
