import { useEffect, useState } from "react";
import { selectProjects } from "@tide/client";
import { Checkbox } from "../ui/Choice.tsx";
import { useModel } from "../../state/model.ts";
import {
  permissionState,
  requestPermission,
  useNotifications,
  type PermissionState,
} from "../../state/notifications.ts";
import section from "./Section.module.css";

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
    <div className={section.section}>
      <div className={section.head}>
        <h3 className={section.title}>Notifications</h3>
      </div>
      <ul className={section.rows}>
        <li className={section.row}>
          <Checkbox
            className={section.check}
            checked={enabled}
            disabled={blocked}
            onChange={(event) => void onEnable(event.target.checked)}
          >
            Notify me when a thread needs me, finishes, fails or hits a usage limit
          </Checkbox>
        </li>
        <li className={section.row}>
          <Checkbox
            className={section.check}
            checked={sound}
            disabled={!enabled}
            onChange={(event) => setSound(event.target.checked)}
          >
            Play a short sound
          </Checkbox>
        </li>
      </ul>
      {blocked ? (
        <p className={section.note} role="status">
          {permission === "denied"
            ? "Notifications are blocked. Allow them for Tide in your browser or system settings, then come back."
            : "This environment does not support notifications."}
        </p>
      ) : null}
      {projects.length > 0 ? (
        <>
          <h4 className={section.title}>Muted projects</h4>
          <ul className={section.rows}>
            {projects.map((p) => (
              <li key={p.id} className={section.row}>
                <Checkbox
                  className={section.check}
                  checked={mutedProjectIds.includes(p.id)}
                  onChange={() => toggleProjectMuted(p.id)}
                >
                  {p.title}
                </Checkbox>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className={section.note}>
        Nothing fires for the thread you are looking at while Tide has focus. Clicking a notification opens its thread
        in the browser; the desktop app brings Tide forward.
      </p>
    </div>
  );
}
