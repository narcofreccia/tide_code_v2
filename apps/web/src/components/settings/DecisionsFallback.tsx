import type { ProviderKind } from "@tide/contracts";
import { patchServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { modelChoiceValue, modelChoices, providerStatus, useProviderRoster } from "../../state/providers.ts";
import { PROVIDER_LABELS } from "../../lib/vocab.ts";
import type { SelectOption } from "../ui/Select.tsx";
import { SettingsGroup } from "./ui/SettingsGroup.tsx";
import { SettingRow } from "./ui/SettingRow.tsx";
import { SettingSelect } from "./ui/SettingSelect.tsx";

const NONE = "none";

/** The judge asked when Jev is unsure: one harness model on the user's own subscription, or none. */
export function DecisionsFallback() {
  const fallback = useServerSettings((s) => s.settings.decisions.fallback);
  const { providers, loading } = useProviderRoster();
  // the fallback names a kind: only default instances (an account or ACP agent cannot be addressed)
  const eligible = providers.filter((p) => p.caps.oneShot === true && p.loggedIn && (p.id || p.kind) === p.kind);
  const options: SelectOption<string>[] = [
    { value: NONE, label: "None (Jev only)" },
    ...eligible.map((p) => ({ value: p.kind, label: PROVIDER_LABELS[p.kind] })),
  ];
  const kind = fallback?.provider;
  const status = kind === undefined ? undefined : providerStatus(providers, kind);
  const models = status?.models ?? [];
  const modelValue = modelChoiceValue(models, fallback?.model);
  const modelLabel = models.find((m) => m.id === modelValue)?.label;

  const pick = (value: string): Promise<void> => {
    if (value === NONE) return patchServerSettings({ decisions: { fallback: null } });
    const provider = value as ProviderKind;
    const next = providerStatus(providers, provider)?.models ?? [];
    const model = next.find((m) => m.default)?.id ?? next[0]?.id;
    return patchServerSettings({ decisions: { fallback: { provider, ...(model === undefined ? {} : { model }) } } });
  };

  return (
    <SettingsGroup
      title="Fallback judge"
      help="Asked only when Jev is unsure (confidence below the high threshold). One-shot, tools off, on your own subscription."
    >
      <SettingRow
        label="Fallback judge"
        help={
          kind === undefined
            ? "No fallback: low-confidence answers from Jev are left unmarked."
            : `Asked as ${PROVIDER_LABELS[kind]}${modelLabel ? ` · ${modelLabel}` : ""}.`
        }
        control={
          <>
            <SettingSelect label="Fallback agent" value={kind ?? NONE} options={options} onSelect={pick} disabled={loading} />
            {kind === undefined ? null : (
              <SettingSelect
                label="Fallback model"
                value={modelValue}
                options={modelChoices(models, kind)}
                onSelect={(model) => patchServerSettings({ decisions: { fallback: { provider: kind, model } } })}
                align="end"
              />
            )}
          </>
        }
      />
    </SettingsGroup>
  );
}
