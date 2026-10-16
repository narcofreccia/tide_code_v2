import { useState } from "react";
import { patchServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Choice.tsx";
import { DecisionsFallback } from "./DecisionsFallback.tsx";
import { DecisionsSpend } from "./DecisionsSpend.tsx";
import { DecisionsTuning } from "./DecisionsTuning.tsx";
import css from "./Decisions.module.css";
import section from "./Section.module.css";

/**
 * TypeSafe's Jev: the optional decision model behind Tide's small yes/no and label questions. The key goes to the server
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
        <h3 className={section.title}>Decisions · TypeSafe Jev</h3>
      </div>
      <div className={css.card}>
        <p className={section.note}>
          Jev is TypeSafe&apos;s calibrated decision model (System One). Tide asks it small yes/no and label
          questions and shows the answers; it never acts on its own. When Jev is not confident, the fallback
          judge below is asked instead.
        </p>
        <div className={css.facts}>
          <span className={css.fact}>Model <span className={css.mono}>{decisions.model}</span></span>
          <span className={css.fact}>Endpoint <span className={css.mono}>{decisions.endpoint}</span></span>
          <span className={css.fact}>${decisions.usdPerMillionInput} per M input tokens</span>
          <span className={css.fact}>
            {decisions.contextTokens / 1000}K-token context (Tide keeps every call under ~8K)
          </span>
        </div>
      </div>
      <ul className={section.rows}>
        <li className={section.row}>
          <Checkbox
            className={section.check}
            checked={decisions.enabled}
            onChange={(event) => void patchServerSettings({ decisions: { enabled: event.target.checked } })}
          >
            Use Jev for decisions
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
      <DecisionsFallback />
      <DecisionsTuning />
      <DecisionsSpend />
    </div>
  );
}
