import type { ProviderKind } from "@tide/contracts";
import { patchServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { modelChoiceValue, modelChoices, providerStatus, useProviderRoster } from "../../state/providers.ts";
import { PROVIDER_LABELS } from "../../lib/vocab.ts";
import type { SelectOption } from "../ui/Select.tsx";
import type { SectionMeta } from "./search.ts";
import { SettingNote, SettingsGroup } from "./ui/SettingsGroup.tsx";
import { SettingsPage } from "./ui/SettingsPage.tsx";
import { SettingRow } from "./ui/SettingRow.tsx";
import { SettingSelect } from "./ui/SettingSelect.tsx";
import { SettingText } from "./ui/SettingText.tsx";
import { SettingToggle } from "./ui/SettingToggle.tsx";

const AUTO = "auto";

export const META: SectionMeta = {
  title: "Inbox",
  blurb:
    "Settling closes a thread from the inbox without touching its worktree or branch; it comes back on its own when it starts a new turn or needs you.",
  keywords: [
    "Auto-settle idle threads after",
    "Auto-settle when the PR is merged or the branch merged back",
    "Group running threads under “Working”",
    "Text generation model",
    "titles",
  ],
};

/** Whole days, never negative; anything unreadable keeps the current value. */
export function parseDays(text: string, current: number): number {
  const n = Number(text.trim());
  if (text.trim() === "" || !Number.isFinite(n)) return current;
  return Math.max(0, Math.round(n));
}

/** Settings › Inbox: the settle rules, the Working group, and the model that writes titles. */
export function InboxSection() {
  const inbox = useServerSettings((s) => s.settings.inbox);
  const textModel = useServerSettings((s) => s.settings.textModel);
  const { providers, loading } = useProviderRoster();
  const kind = textModel?.provider;
  // the chosen harness stays listed while the roster is still probing (or it logged out), so the
  // field never shows a blank for a value the server holds
  const eligible = providers.filter((p) => (p.id || p.kind) === p.kind && ((p.caps.oneShot === true && p.loggedIn) || p.kind === kind));
  const agentOptions: SelectOption<string>[] = [
    { value: AUTO, label: "Automatic" },
    ...(kind !== undefined && !eligible.some((p) => p.kind === kind) ? [{ value: kind, label: PROVIDER_LABELS[kind] }] : []),
    ...eligible.map((p) => ({ value: p.kind, label: PROVIDER_LABELS[p.kind] })),
  ];
  const models = kind === undefined ? [] : (providerStatus(providers, kind)?.models ?? []);

  const pickAgent = (value: string): Promise<void> => {
    if (value === AUTO) return patchServerSettings({ textModel: null });
    const provider = value as ProviderKind;
    const next = providerStatus(providers, provider)?.models ?? [];
    const model = next.find((m) => m.default)?.id ?? next[0]?.id;
    return patchServerSettings({ textModel: { provider, ...(model === undefined ? {} : { model }) } });
  };

  return (
    <SettingsPage title={META.title} blurb={META.blurb}>
      <SettingsGroup title="Settling">
        <SettingRow
          label="Auto-settle idle threads after"
          help="0 turns automatic settling off."
          control={
            <SettingText
              label="Auto-settle after days"
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              size="short"
              value={String(inbox.autoSettleAfterDays)}
              normalize={(text) => String(parseDays(text, inbox.autoSettleAfterDays))}
              onCommit={(text) => patchServerSettings({ inbox: { autoSettleAfterDays: Number(text) } })}
              suffix={inbox.autoSettleAfterDays === 0 ? "days (never)" : "days"}
            />
          }
        />
        <SettingRow
          label="Auto-settle when the PR is merged or the branch merged back"
          control={(id) => (
            <SettingToggle
              id={id}
              checked={inbox.autoSettleOnMerge}
              onChange={(on) => patchServerSettings({ inbox: { autoSettleOnMerge: on } })}
            />
          )}
        />
        <SettingRow
          label="Group running threads under “Working”"
          help="Pinned threads stay where they are."
          control={(id) => (
            <SettingToggle
              id={id}
              checked={inbox.workingSection}
              onChange={(on) => patchServerSettings({ inbox: { workingSection: on } })}
            />
          )}
        />
        <SettingNote>
          Pinned threads, threads that are running or waiting on you, and threads with auto-settle turned off (thread
          menu) are never settled automatically.
        </SettingNote>
      </SettingsGroup>
      <SettingsGroup title="Titles">
        <SettingRow
          label="Text generation model"
          help="Thread titles are written one-shot on your own subscription; Automatic uses the first harness that can."
          control={
            <>
              <SettingSelect
                label="Text generation agent"
                value={kind ?? AUTO}
                options={agentOptions}
                onSelect={pickAgent}
                disabled={loading}
              />
              {kind === undefined ? null : (
                <SettingSelect
                  label="Text generation model"
                  value={modelChoiceValue(models, textModel?.model)}
                  options={modelChoices(models, kind)}
                  onSelect={(model) => patchServerSettings({ textModel: { provider: kind, model } })}
                  align="end"
                />
              )}
            </>
          }
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
