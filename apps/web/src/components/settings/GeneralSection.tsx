import { useState } from "react";
import { Select } from "../ui/Select.tsx";
import {
  readFollowUpMode,
  readLimitPolicy,
  writeFollowUpMode,
  writeLimitPolicy,
  type FollowUpMode,
  type LimitPolicy,
} from "./generalPrefs.ts";
import section from "./Section.module.css";

const FOLLOW_UP: { value: FollowUpMode; label: string }[] = [
  { value: "steer", label: "Steer" },
  { value: "queue", label: "Queue" },
];
const LIMIT: { value: LimitPolicy; label: string }[] = [
  { value: "manual", label: "Wait for me" },
  { value: "reset", label: "Resume at reset" },
];

/** Defaults for follow-up messages and usage limits; both live in localStorage. */
export function GeneralSection() {
  const [followUp, setFollowUp] = useState(readFollowUpMode);
  const [limit, setLimit] = useState(readLimitPolicy);

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
            value={followUp}
            options={FOLLOW_UP}
            onSelect={(v) => {
              setFollowUp(v);
              writeFollowUpMode(v);
            }}
            variant="field"
            size="md"
          />
        </li>
        <li className={section.row}>
          <span className={section.label}>When a provider reports its usage limit</span>
          <Select
            label="Usage limit policy"
            value={limit}
            options={LIMIT}
            onSelect={(v) => {
              setLimit(v);
              writeLimitPolicy(v);
            }}
            variant="field"
            size="md"
          />
        </li>
      </ul>
      <p className={section.note}>
        Steer sends a message sent mid-turn into the running turn; Queue runs it after the turn ends. Switching a
        thread to another harness carries a budgeted excerpt of its history, not the full session — handoffs are lossy.
      </p>
    </div>
  );
}
