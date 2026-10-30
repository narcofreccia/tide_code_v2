import { useEffect, useState } from "react";
import type { ProviderKind } from "@tide/contracts";
import { patchServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { modelChoiceValue, modelChoices, providerStatus, useProviderRoster } from "../../state/providers.ts";
import { PROVIDER_LABELS } from "../../lib/vocab.ts";
import { Checkbox } from "../ui/Choice.tsx";
import { Select, type SelectOption } from "../ui/Select.tsx";
import section from "./Section.module.css";
import css from "./Inbox.module.css";

const AUTO = "auto";

/** Whole days, never negative; anything unreadable keeps the current value. */
export function parseDays(text: string, current: number): number {
  const n = Number(text.trim());
  if (text.trim() === "" || !Number.isFinite(n)) return current;
  return Math.max(0, Math.round(n));
}

function DaysField({ value }: { value: number }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (): void => {
    const days = parseDays(text, value);
    setText(String(days));
    if (days !== value) void patchServerSettings({ inbox: { autoSettleAfterDays: days } });
  };
  return (
    <span className={css.days}>
      <input
        className={`${section.input} ${css.daysInput}`}
        type="number"
        min={0}
        step={1}
        inputMode="numeric"
        aria-label="Auto-settle after days"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      <span className={section.label}>{value === 0 ? "days (never)" : "days"}</span>
    </span>
  );
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

  const pickAgent = (value: string): void => {
    if (value === AUTO) {
      void patchServerSettings({ textModel: null });
      return;
    }
    const provider = value as ProviderKind;
    const next = providerStatus(providers, provider)?.models ?? [];
    const model = next.find((m) => m.default)?.id ?? next[0]?.id;
    void patchServerSettings({ textModel: { provider, ...(model === undefined ? {} : { model }) } });
  };

  return (
    <div className={section.section}>
      <div className={section.head}>
        <h3 className={section.title}>Inbox</h3>
      </div>
      <p className={section.note}>
        Settling closes a thread from the inbox without touching its worktree or branch; it comes back on its own when
        it starts a new turn or needs you.
      </p>
      <ul className={section.rows}>
        <li className={section.row}>
          <span className={section.label}>Auto-settle idle threads after</span>
          <DaysField value={inbox.autoSettleAfterDays} />
        </li>
        <li className={section.row}>
          <Checkbox
            className={section.check}
            checked={inbox.autoSettleOnMerge}
            onChange={(e) => void patchServerSettings({ inbox: { autoSettleOnMerge: e.target.checked } })}
          >
            Auto-settle when the PR is merged or the branch merged back
          </Checkbox>
        </li>
        <li className={section.row}>
          <Checkbox
            className={section.check}
            checked={inbox.workingSection}
            onChange={(e) => void patchServerSettings({ inbox: { workingSection: e.target.checked } })}
          >
            Group running threads under “Working” (pinned ones stay put)
          </Checkbox>
        </li>
        <li className={section.row}>
          <span className={section.label}>Text generation model</span>
          <span className={css.pick}>
            <Select
              label="Text generation agent"
              value={kind ?? AUTO}
              options={agentOptions}
              onSelect={pickAgent}
              variant="field"
              size="md"
              disabled={loading}
            />
            {kind === undefined ? null : (
              <Select
                label="Text generation model"
                value={modelChoiceValue(models, textModel?.model)}
                options={modelChoices(models, kind)}
                onSelect={(model) => void patchServerSettings({ textModel: { provider: kind, model } })}
                variant="field"
                size="md"
                align="end"
              />
            )}
          </span>
        </li>
      </ul>
      <p className={section.note}>
        Pinned threads, threads that are running or waiting on you, and threads with auto-settle turned off (thread
        menu) are never settled automatically. Thread titles are written one-shot on your own subscription;
        Automatic uses the first harness that can.
      </p>
    </div>
  );
}
