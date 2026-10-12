import { useState } from "react";
import { patchServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Choice.tsx";
import section from "./Section.module.css";

/**
 * The optional decisions model behind Inbox triage. The key goes to the server
 * once and is never read back: the client only learns `hasKey`.
 */
export function DecisionsSection() {
  const decisions = useServerSettings((s) => s.settings.decisions);
  const [key, setKey] = useState("");

  const saveKey = (): void => {
    const apiKey = key.trim();
    if (apiKey === "") return;
    setKey("");
    void patchServerSettings({ decisions: { apiKey } });
  };

  return (
    <div className={section.section}>
      <div className={section.head}>
        <h3 className={section.title}>Decisions</h3>
      </div>
      <p className={section.note}>
        An optional model that ranks the Inbox (urgency, possibly stuck). It only annotates; Tide never
        acts on its answers.
      </p>
      <ul className={section.rows}>
        <li className={section.row}>
          <Checkbox
            className={section.check}
            checked={decisions.enabled}
            onChange={(event) => void patchServerSettings({ decisions: { enabled: event.target.checked } })}
          >
            Triage the Inbox with the decisions model
          </Checkbox>
        </li>
        <li className={section.row}>
          <span className={section.label}>API key</span>
          <span className={`${section.value} ${decisions.hasKey ? section.ok : ""}`}>
            {decisions.hasKey ? "key set" : "no key"}
          </span>
        </li>
      </ul>
      <form
        className={section.form}
        onSubmit={(event) => {
          event.preventDefault();
          saveKey();
        }}
      >
        <div className={section.formRow}>
          <input
            className={section.input}
            type="password"
            autoComplete="off"
            aria-label="Decisions API key"
            placeholder={decisions.hasKey ? "replace the stored key" : "paste an API key"}
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <Button type="submit" variant="primary" disabled={key.trim() === ""}>
            Save key
          </Button>
        </div>
        <p className={section.note}>Stored on the server only; it is never shown again.</p>
      </form>
    </div>
  );
}
