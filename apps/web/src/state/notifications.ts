import { create } from "zustand";

const KEY = "tide.notifications";

export interface NotificationPrefs {
  enabled: boolean;
  sound: boolean;
  mutedProjectIds: string[];
}

interface NotificationState extends NotificationPrefs {
  setEnabled: (enabled: boolean) => void;
  setSound: (sound: boolean) => void;
  toggleProjectMuted: (projectId: string) => void;
}

function load(): NotificationPrefs {
  const fallback: NotificationPrefs = { enabled: false, sound: false, mutedProjectIds: [] };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<NotificationPrefs> | null;
    if (!raw) return fallback;
    return {
      enabled: raw.enabled === true,
      sound: raw.sound === true,
      mutedProjectIds: Array.isArray(raw.mutedProjectIds)
        ? raw.mutedProjectIds.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return fallback;
  }
}

function save(s: NotificationPrefs): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ enabled: s.enabled, sound: s.sound, mutedProjectIds: s.mutedProjectIds }),
    );
  } catch {
    // storage unavailable; prefs live for the session only
  }
}

export const useNotifications = create<NotificationState>((set, get) => {
  const commit = (patch: Partial<NotificationPrefs>): void => {
    set(patch);
    save(get());
  };
  return {
    ...load(),
    setEnabled: (enabled) => commit({ enabled }),
    setSound: (sound) => commit({ sound }),
    toggleProjectMuted: (projectId) => {
      const muted = get().mutedProjectIds;
      commit({
        mutedProjectIds: muted.includes(projectId) ? muted.filter((id) => id !== projectId) : [...muted, projectId],
      });
    },
  };
});

export function resetNotifications(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  useNotifications.setState({ enabled: false, sound: false, mutedProjectIds: [] });
}

export type PermissionState = "granted" | "denied" | "default" | "unsupported";

/** True inside the Tauri WebView; the plugin module is only ever imported behind this guard. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function permissionState(): Promise<PermissionState> {
  if (isTauri()) {
    const { isPermissionGranted } = await import("@tauri-apps/plugin-notification");
    return (await isPermissionGranted()) ? "granted" : "default";
  }
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

export async function requestPermission(): Promise<PermissionState> {
  if (isTauri()) {
    const { requestPermission: ask } = await import("@tauri-apps/plugin-notification");
    return (await ask()) as PermissionState;
  }
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.requestPermission();
}
