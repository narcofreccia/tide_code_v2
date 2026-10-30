import type { UserSettings } from "@tide/contracts";
import {
  setContinueAfterRestart,
  setFollowUpDefault,
  setLimitPolicyDefault,
  useServerSettings,
} from "../../state/serverSettings.ts";
import type { SectionMeta } from "./search.ts";
import { SettingNote, SettingsGroup } from "./ui/SettingsGroup.tsx";
import { SettingsPage } from "./ui/SettingsPage.tsx";
import { SettingRow } from "./ui/SettingRow.tsx";
import { SettingSelect } from "./ui/SettingSelect.tsx";
import { SettingToggle } from "./ui/SettingToggle.tsx";

type FollowUpMode = UserSettings["followUpMode"];
type LimitPolicy = UserSettings["limitPolicy"];

const FOLLOW_UP: { value: FollowUpMode; label: string }[] = [
  { value: "steer", label: "Steer" },
  { value: "queue", label: "Queue" },
];
const LIMIT: { value: LimitPolicy; label: string }[] = [
  { value: "manual", label: "Wait for me" },
  { value: "reset", label: "Resume at reset" },
];

export const META: SectionMeta = {
  title: "General",
  blurb: "How threads behave when you write mid-turn, hit a usage limit or restart the server.",
  keywords: ["Follow-up default", "When a provider reports its usage limit", "Continue threads after a restart", "steer", "queue", "handoff"],
};

/** Follow-up, usage-limit and restart defaults; server-side, so every client agrees. */
export function GeneralSection() {
  const settings = useServerSettings((s) => s.settings);

  return (
    <SettingsPage title={META.title} blurb={META.blurb}>
      <SettingsGroup title="Threads">
        <SettingRow
          label="Follow-up default"
          help="Steer sends a message sent mid-turn into the running turn; Queue runs it after the turn ends (⌘↵ sends the default, ⌥↵ the other)."
          control={
            <SettingSelect label="Follow-up default" value={settings.followUpMode} options={FOLLOW_UP} onSelect={setFollowUpDefault} />
          }
        />
        <SettingRow
          label="When a provider reports its usage limit"
          control={
            <SettingSelect label="Usage limit policy" value={settings.limitPolicy} options={LIMIT} onSelect={setLimitPolicyDefault} />
          }
        />
        <SettingRow
          label="Continue threads after a restart"
          control={(id) => (
            <SettingToggle id={id} checked={settings.continueAfterRestart} onChange={setContinueAfterRestart} />
          )}
        />
        <SettingNote>
          Switching a thread to another harness carries a budgeted excerpt of its history, not the full session:
          handoffs are lossy.
        </SettingNote>
      </SettingsGroup>
    </SettingsPage>
  );
}
