import { useUi } from "../state/ui.ts";
import { isTauri, useNotifications } from "../state/notifications.ts";

export interface NotifyInput {
  title: string;
  body: string;
  threadId: string;
  /** identical tags inside the dedupe window collapse to one notification */
  tag: string;
}

const DEDUPE_MS = 5000;
const recent = new Map<string, number>();

export function resetNotify(): void {
  recent.clear();
}

let audio: AudioContext | undefined;

function beep(): void {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.18);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.2);
  } catch {
    // no audio device or autoplay policy; the notification still shows
  }
}

function select(threadId: string): void {
  useUi.getState().selectThread(threadId);
  window.focus();
}

async function send(n: NotifyInput): Promise<void> {
  if (isTauri()) {
    const { isPermissionGranted, sendNotification } = await import("@tauri-apps/plugin-notification");
    if (await isPermissionGranted()) sendNotification({ title: n.title, body: n.body });
    return;
  }
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const note = new Notification(n.title, { body: n.body, tag: n.tag });
  note.onclick = () => {
    select(n.threadId);
    note.close();
  };
}

/** Raises an OS notification (and optional beep) unless disabled or a duplicate tag fired within 5 s. */
export async function notify(n: NotifyInput, now: number = Date.now()): Promise<boolean> {
  const prefs = useNotifications.getState();
  if (!prefs.enabled) return false;
  const last = recent.get(n.tag);
  if (last !== undefined && now - last < DEDUPE_MS) return false;
  recent.set(n.tag, now);
  if (prefs.sound) beep();
  try {
    await send(n);
  } catch {
    return false;
  }
  return true;
}
