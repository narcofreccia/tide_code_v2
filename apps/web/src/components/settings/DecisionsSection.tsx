import { useState } from "react";
import { patchServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { Button } from "../ui/Button.tsx";
import { DecisionsFallback } from "./DecisionsFallback.tsx";
import { DecisionsSpend } from "./DecisionsSpend.tsx";
import { DecisionsTuning } from "./DecisionsTuning.tsx";
import type { SectionMeta } from "./search.ts";
import { SettingsGroup } from "./ui/SettingsGroup.tsx";
import { SettingsPage } from "./ui/SettingsPage.tsx";
import { SettingRow } from "./ui/SettingRow.tsx";
import { SettingToggle } from "./ui/SettingToggle.tsx";
import { useTrackSave } from "./ui/saved.ts";
import ui from "./ui/settings.module.css";
import css from "./Decisions.module.css";

export const META: SectionMeta = {
  title: "Decisions",
  blurb:
    "Jev is TypeSafe's calibrated decision model (System One). Tide asks it small yes/no and label questions and shows the answers; it never acts on its own.",
  keywords: [
    "Use Jev for decisions",
    "API key",
    "Fallback judge",
    "Gray zone",
    "Handoff",
    "Delegates",
    "Approvals",
    "Experts",
    "Stuck",
    "Advance experts automatically when converged",
    "Spend",
    "TypeSafe",
  ],
};

/** The key goes to the server once and is never read back: the client only learns `hasKey`. */
function KeyForm({ hasKey }: { hasKey: boolean }) {
  const [key, setKey] = useState("");
  const track = useTrackSave();
  const saveKey = (): void => {
    const apiKey = key.trim();
    if (apiKey === "") return;
    setKey("");
    track(() => patchServerSettings({ decisions: { apiKey } }));
  };
  return (
    <form
      className={css.keyForm}
      onSubmit={(event) => {
        event.preventDefault();
        saveKey();
      }}
    >
      <input
        className={`${ui.input} ${ui.mono} ${css.keyInput}`}
        type="password"
        autoComplete="off"
        aria-label="Decisions API key"
        placeholder={hasKey ? "replace the stored key" : "paste an API key"}
        value={key}
        onChange={(event) => setKey(event.target.value)}
      />
      <Button type="submit" variant="primary" disabled={key.trim() === ""}>
        Save key
      </Button>
    </form>
  );
}

/** TypeSafe's Jev: the optional decision model behind Tide's small yes/no and label questions. */
export function DecisionsSection() {
  const decisions = useServerSettings((s) => s.settings.decisions);

  return (
    <SettingsPage title={META.title} blurb={META.blurb}>
      <SettingsGroup
        title="TypeSafe Jev"
        help={
          <span className={css.facts}>
            <span>
              Model <span className={css.mono}>{decisions.model}</span>
            </span>
            <span>
              Endpoint <span className={css.mono}>{decisions.endpoint}</span>
            </span>
            <span>${decisions.usdPerMillionInput} per M input tokens</span>
            <span>{decisions.contextTokens / 1000}K-token context (Tide keeps every call under ~8K)</span>
          </span>
        }
      >
        <SettingRow
          label="Use Jev for decisions"
          help="When Jev is not confident, the fallback judge below is asked instead."
          control={(id) => (
            <SettingToggle
              id={id}
              checked={decisions.enabled}
              onChange={(enabled) => patchServerSettings({ decisions: { enabled } })}
            />
          )}
        />
        <SettingRow
          label="API key"
          help="Stored on the server only; it is never shown again."
          control={
            <>
              <span className={`${ui.value} ${decisions.hasKey ? ui.ok : ""}`}>{decisions.hasKey ? "key set" : "no key"}</span>
              <KeyForm hasKey={decisions.hasKey} />
            </>
          }
        />
      </SettingsGroup>
      <DecisionsFallback />
      <DecisionsTuning />
      <DecisionsSpend />
    </SettingsPage>
  );
}
