import type { ProviderKind } from "@tide/contracts";
import { patchServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { modelChoiceValue, modelChoices, providerStatus, useProviderRoster } from "../../state/providers.ts";
import { PROVIDER_LABELS } from "../../lib/vocab.ts";
import { Select, type SelectOption } from "../ui/Select.tsx";
import css from "./Decisions.module.css";

const NONE = "none";

/** The judge asked when Jev is unsure: one harness model on the user's own subscription, or none. */
export function DecisionsFallback() {
  const fallback = useServerSettings((s) => s.settings.decisions.fallback);
  const { providers, loading } = useProviderRoster();
  const eligible = providers.filter((p) => p.caps.oneShot === true && p.loggedIn);
  const options: SelectOption<string>[] = [
    { value: NONE, label: "None (Jev only)" },
    ...eligible.map((p) => ({ value: p.kind, label: PROVIDER_LABELS[p.kind] })),
  ];
  const kind = fallback?.provider;
  const status = kind === undefined ? undefined : providerStatus(providers, kind);
  const models = status?.models ?? [];
  const modelValue = modelChoiceValue(models, fallback?.model);
  const modelLabel = models.find((m) => m.id === modelValue)?.label;

  const pick = (value: string): void => {
    if (value === NONE) {
      void patchServerSettings({ decisions: { fallback: null } });
      return;
    }
    const provider = value as ProviderKind;
    const next = providerStatus(providers, provider)?.models ?? [];
    const model = next.find((m) => m.default)?.id ?? next[0]?.id;
    void patchServerSettings({ decisions: { fallback: { provider, ...(model === undefined ? {} : { model }) } } });
  };

  return (
    <div className={css.card}>
      <h4 className={css.cardTitle}>Fallback judge</h4>
      <div className={css.pickRow}>
        <Select
          label="Fallback agent"
          value={kind ?? NONE}
          options={options}
          onSelect={pick}
          variant="field"
          size="md"
          disabled={loading}
        />
        {kind === undefined ? null : (
          <Select
            label="Fallback model"
            value={modelValue}
            options={modelChoices(models, kind)}
            onSelect={(model) => void patchServerSettings({ decisions: { fallback: { provider: kind, model } } })}
            variant="field"
            size="md"
            align="end"
          />
        )}
      </div>
      <p className={css.note}>
        {kind === undefined
          ? "No fallback: low-confidence answers from Jev are left unmarked."
          : `Asked as ${PROVIDER_LABELS[kind]}${modelLabel ? ` · ${modelLabel}` : ""}.`}{" "}
        Asked only when Jev is unsure (confidence below the high threshold). One-shot, tools off, on your own
        subscription.
      </p>
    </div>
  );
}
