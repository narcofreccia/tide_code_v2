import { Checkbox } from "../ui/Choice.tsx";
import { Button } from "../ui/Button.tsx";
import { patchServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { useUi } from "../../state/ui.ts";
import section from "./Section.module.css";

/** R10: where the harness limits show and whether the usage page reads the harnesses' own logs. */
export function GlassBoxSection() {
  const glassBox = useServerSettings((s) => s.settings.glassBox);
  const showUsage = useUi((s) => s.showUsage);

  return (
    <div className={section.section}>
      <div className={section.head}>
        <h3 className={section.title}>Glass box</h3>
      </div>
      <ul className={section.rows}>
        <li className={section.row}>
          <Checkbox
            className={section.check}
            checked={glassBox.limitsInStatusBar}
            onChange={(event) => void patchServerSettings({ glassBox: { limitsInStatusBar: event.target.checked } })}
          >
            Show the tightest harness limit in the status bar
          </Checkbox>
        </li>
        <li className={section.row}>
          <Checkbox
            className={section.check}
            checked={glassBox.readHarnessLogs}
            onChange={(event) => void patchServerSettings({ glassBox: { readHarnessLogs: event.target.checked } })}
          >
            Read harness logs for usage outside Tide
          </Checkbox>
        </li>
      </ul>
      <p className={section.note}>
        Limits are what the harness last reported (5 h and weekly windows). With harness logs on, the Usage page also
        counts sessions you ran in the terminal, read from the harnesses' own local files; nothing leaves this machine.{" "}
        <Button variant="link" onClick={showUsage}>
          Open Usage →
        </Button>
      </p>
    </div>
  );
}
