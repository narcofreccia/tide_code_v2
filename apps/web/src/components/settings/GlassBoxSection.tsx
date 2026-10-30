import { Button } from "../ui/Button.tsx";
import { patchServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { useUi } from "../../state/ui.ts";
import type { SectionMeta } from "./search.ts";
import { SettingNote, SettingsGroup } from "./ui/SettingsGroup.tsx";
import { SettingsPage } from "./ui/SettingsPage.tsx";
import { SettingRow } from "./ui/SettingRow.tsx";
import { SettingToggle } from "./ui/SettingToggle.tsx";

export const META: SectionMeta = {
  title: "Glass box",
  blurb: "Where the harness limits show, and whether the Usage page reads the harnesses' own logs.",
  keywords: ["Show the tightest harness limit in the status bar", "Read harness logs for usage outside Tide", "usage", "limits"],
};

/** R10: where the harness limits show and whether the usage page reads the harnesses' own logs. */
export function GlassBoxSection() {
  const glassBox = useServerSettings((s) => s.settings.glassBox);
  const showUsage = useUi((s) => s.showUsage);

  return (
    <SettingsPage title={META.title} blurb={META.blurb}>
      <SettingsGroup
        title="Limits and usage"
        actions={
          <Button variant="link" onClick={showUsage}>
            Open Usage →
          </Button>
        }
      >
        <SettingRow
          label="Show the tightest harness limit in the status bar"
          help="Limits are what the harness last reported (5 h and weekly windows)."
          control={(id) => (
            <SettingToggle
              id={id}
              checked={glassBox.limitsInStatusBar}
              onChange={(on) => patchServerSettings({ glassBox: { limitsInStatusBar: on } })}
            />
          )}
        />
        <SettingRow
          label="Read harness logs for usage outside Tide"
          help="The Usage page also counts sessions you ran in the terminal, read from the harnesses' own local files."
          control={(id) => (
            <SettingToggle
              id={id}
              checked={glassBox.readHarnessLogs}
              onChange={(on) => patchServerSettings({ glassBox: { readHarnessLogs: on } })}
            />
          )}
        />
        <SettingNote>Nothing leaves this machine.</SettingNote>
      </SettingsGroup>
    </SettingsPage>
  );
}
