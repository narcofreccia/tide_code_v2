import { useEffect, useState } from "react";
import { selectProjects } from "@tide/client";
import { useModel } from "../../state/model.ts";
import {
  permissionState,
  requestPermission,
  useNotifications,
  type PermissionState,
} from "../../state/notifications.ts";
import type { SectionMeta } from "./search.ts";
import { SettingNote, SettingsGroup } from "./ui/SettingsGroup.tsx";
import { SettingsPage } from "./ui/SettingsPage.tsx";
import { SettingRow } from "./ui/SettingRow.tsx";
import { SettingToggle } from "./ui/SettingToggle.tsx";

export const META: SectionMeta = {
  title: "Notifications",
  blurb: "OS notifications when a thread needs you, finishes, fails or hits a usage limit while you look elsewhere.",
  keywords: ["Notify me when a thread needs me, finishes, fails or hits a usage limit", "Play a short sound", "Muted projects", "mute"],
};

/** OS notifications when a thread needs you, finishes, fails or hits a usage limit while you look elsewhere. */
export function NotificationsSection() {
  const { enabled, sound, mutedProjectIds, setEnabled, setSound, toggleProjectMuted } = useNotifications();
  const projects = selectProjects(useModel((s) => s.model));
  const [permission, setPermission] = useState<PermissionState>("default");

  useEffect(() => {
    void permissionState().then(setPermission, () => setPermission("unsupported"));
  }, []);

  const onEnable = async (on: boolean): Promise<void> => {
    if (!on) return setEnabled(false);
    const next = permission === "granted" ? permission : await requestPermission().catch((): PermissionState => "denied");
    setPermission(next);
    setEnabled(next === "granted");
  };

  const blocked = permission === "denied" || permission === "unsupported";

  return (
    <SettingsPage title={META.title} blurb={META.blurb}>
      <SettingsGroup
        title="This device"
        help="Nothing fires for the thread you are looking at while Tide has focus. Clicking a notification opens its thread in the browser; the desktop app brings Tide forward."
      >
        <SettingRow
          label="Notify me when a thread needs me, finishes, fails or hits a usage limit"
          control={(id) => (
            <SettingToggle
              id={id}
              checked={enabled}
              disabled={blocked}
              onChange={(on) => {
                void onEnable(on);
              }}
            />
          )}
        />
        <SettingRow
          label="Play a short sound"
          control={(id) => <SettingToggle id={id} checked={sound} disabled={!enabled} onChange={setSound} />}
        />
        {blocked ? (
          <SettingNote role="status">
            {permission === "denied"
              ? "Notifications are blocked. Allow them for Tide in your browser or system settings, then come back."
              : "This environment does not support notifications."}
          </SettingNote>
        ) : null}
      </SettingsGroup>
      {projects.length > 0 ? (
        <SettingsGroup title="Muted projects" help="A muted project's threads never notify.">
          {projects.map((p) => (
            <SettingRow
              key={p.id}
              id={`setting-muted-${p.id}`}
              label={p.title}
              control={(id) => (
                <SettingToggle id={id} checked={mutedProjectIds.includes(p.id)} onChange={() => toggleProjectMuted(p.id)} />
              )}
            />
          ))}
        </SettingsGroup>
      ) : null}
    </SettingsPage>
  );
}
