import type { UserSettings } from "@tide/contracts";
import { Select } from "../ui/Select.tsx";
import { Checkbox } from "../ui/Choice.tsx";
import {
  setContinueAfterRestart,
  setFollowUpDefault,
  setLimitPolicyDefault,
  useServerSettings,
} from "../../state/serverSettings.ts";
import section from "./Section.module.css";

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

/** Follow-up, usage-limit and restart defaults; server-side, so every client agrees. */
export function GeneralSection() {
  const settings = useServerSettings((s) => s.settings);

  return (
    <div className={section.section}>
      <div className={section.head}>
        <h3 className={section.title}>General</h3>
      </div>
      <ul className={section.rows}>
        <li className={section.row}>
          <span className={section.label}>Follow-up default</span>
          <Select
            label="Follow-up default"
            value={settings.followUpMode}
            options={FOLLOW_UP}
            onSelect={(v) => void setFollowUpDefault(v)}
            variant="field"
            size="md"
          />
        </li>
        <li className={section.row}>
          <span className={section.label}>When a provider reports its usage limit</span>
          <Select
            label="Usage limit policy"
            value={settings.limitPolicy}
            options={LIMIT}
            onSelect={(v) => void setLimitPolicyDefault(v)}
            variant="field"
            size="md"
          />
        </li>
        <li className={section.row}>
          <Checkbox
            className={section.check}
            checked={settings.continueAfterRestart}
            onChange={(event) => void setContinueAfterRestart(event.target.checked)}
          >
            Continue threads after a restart
          </Checkbox>
        </li>
      </ul>
      <p className={section.note}>
        Steer sends a message sent mid-turn into the running turn; Queue runs it after the turn ends (⌘↵ sends the
        default, ⌥↵ the other). Switching a thread to another harness carries a budgeted excerpt of its history, not
        the full session — handoffs are lossy.
      </p>
    </div>
  );
}
