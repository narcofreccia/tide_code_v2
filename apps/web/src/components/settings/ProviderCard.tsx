import type { ProviderInstanceConfig, ProviderStatusDto } from "@tide/contracts";
import { PROVIDER_LABELS, RUNTIME_MODES, RUNTIME_MODE_HINTS, RUNTIME_MODE_LABELS } from "../../lib/vocab.ts";
import { resolveLoginCommand, runOrCopy } from "../../lib/providerLogin.ts";
import { loadProviders, modelChoiceValue, modelChoices } from "../../state/providers.ts";
import { setProviderDefault, useServerSettings } from "../../state/serverSettings.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { Pill } from "../ui/Pill.tsx";
import { Select, type SelectOption } from "../ui/Select.tsx";
import { Popover } from "../ui/Popover.tsx";
import providers from "./providers/Providers.module.css";
import section from "./Section.module.css";
import styles from "./ProviderCard.module.css";
import { plural } from "../../lib/format.ts";

const CAPS: { key: keyof ProviderStatusDto["caps"]; label: string }[] = [
  { key: "planMode", label: "plan mode" },
  { key: "subagents", label: "sub-agents" },
  { key: "mcp", label: "MCP" },
  { key: "images", label: "images" },
  { key: "resume", label: "resume" },
  { key: "contextUsage", label: "context usage" },
  { key: "openInTerminal", label: "open in terminal" },
  { key: "effort", label: "effort" },
  { key: "commands", label: "slash commands" },
];

/** `○ not installed · ◐ installed, logged out · ● ready` */
export function statusOf(p: ProviderStatusDto): { glyph: string; text: string; tone: string } {
  if (!p.installed) return { glyph: "○", text: "Not installed", tone: "off" };
  if (!p.loggedIn) return { glyph: "◐", text: "Installed · not logged in", tone: "warn" };
  const version = p.version ? ` · v${p.version.replace(/^v/, "")}` : "";
  return { glyph: "●", text: `Installed · logged in${version}`, tone: "ok" };
}

function ModelList({ status }: { status: ProviderStatusDto }) {
  const families = new Map<string, ProviderStatusDto["models"]>();
  for (const model of status.models) {
    const family = model.family ?? "models";
    families.set(family, [...(families.get(family) ?? []), model]);
  }
  if (status.models.length === 0) return <p className={section.note}>No models reported.</p>;
  return (
    <details className={styles.models}>
      <summary>{plural(status.models.length, "model")}</summary>
      {[...families].map(([family, models]) => (
        <div key={family}>
          <span className={section.group}>{family}</span>
          <ul className={styles.modelList}>
            {models.map((model) => (
              <li key={model.id}>
                <span className={section.value}>{model.label}</span>
                {model.default ? <Pill tone="accent">default</Pill> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </details>
  );
}

/** `⋯` on a user-added instance: edit or remove it. */
function InstanceMenu({ name, onEdit, onRemove }: { name: string; onEdit: () => void; onRemove: () => void }) {
  return (
    <Popover label="⋯" title={`More actions for ${name}`} variant="quiet" align="end">
      {(close) => (
        <div className={providers.menu}>
          <Button variant="quiet" onClick={() => (close(), onEdit())}>
            Edit…
          </Button>
          <Button variant="quiet" onClick={() => (close(), onRemove())}>
            Remove…
          </Button>
        </div>
      )}
    </Popover>
  );
}

/**
 * One harness instance: status, login affordance, capabilities, models and its
 * defaults. A bundled default offers "Add account"; a user-added instance an Edit/Remove menu.
 */
export function ProviderCard({
  status,
  instance,
  onAddAccount,
  onEdit,
  onRemove,
}: {
  status: ProviderStatusDto;
  /** set for an instance the user added (an account or an ACP agent) */
  instance?: ProviderInstanceConfig | undefined;
  onAddAccount?: (() => void) | undefined;
  onEdit?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
}) {
  const kind = status.kind;
  const id = status.id || kind;
  const name = status.label || PROVIDER_LABELS[kind];
  const defaults = useServerSettings((s) => s.settings.providerDefaults[id]) ?? {};
  const threadId = useUi((s) => s.selectedThreadId);
  const { glyph, text, tone } = statusOf(status);
  const command = resolveLoginCommand(status);
  const modelOptions: SelectOption<string>[] = modelChoices(status.models, id, [status]);
  const modeOptions = RUNTIME_MODES.map((mode) => ({
    value: mode,
    label: RUNTIME_MODE_LABELS[mode],
    description: RUNTIME_MODE_HINTS[mode],
  }));

  return (
    <article className={styles.card} aria-label={name}>
      <header className={styles.head}>
        <h4 className={styles.name}>
          {name}
          {name === PROVIDER_LABELS[kind] ? null : <span className={providers.kind}>{PROVIDER_LABELS[kind]}</span>}
        </h4>
        <span className={providers.headActions}>
          {onAddAccount ? (
            <Button variant="quiet" onClick={onAddAccount} title={`Add another ${PROVIDER_LABELS[kind]} login`}>
              Add account
            </Button>
          ) : null}
          <Button variant="quiet" onClick={() => loadProviders(true)} title={`Re-probe ${name}`}>
            Refresh
          </Button>
          {instance && onEdit && onRemove ? <InstanceMenu name={name} onEdit={onEdit} onRemove={onRemove} /> : null}
        </span>
      </header>

      <p className={`${styles.status} ${styles[tone] ?? ""}`} data-tone={tone}>
        <span aria-hidden="true">{glyph}</span> {text}
      </p>
      {status.hint ? <p className={section.note}>{status.hint}</p> : null}
      {command ? (
        <div>
          <Button onClick={() => void runOrCopy(command)}>
            {threadId ? "Open terminal" : "Copy login command"}
          </Button>
          <code className={styles.command}>{command}</code>
        </div>
      ) : null}

      <ul className={styles.caps} aria-label={`${name} capabilities`}>
        {CAPS.map((cap) => (
          <li
            key={cap.key}
            data-cap={cap.key}
            data-on={status.caps[cap.key] ? "true" : "false"}
            className={status.caps[cap.key] ? "" : styles.capOff}
          >
            <Pill>{cap.label}</Pill>
          </li>
        ))}
      </ul>

      <ModelList status={status} />

      <div className={styles.defaults}>
        <div className={styles.field}>
          <span className={section.label}>default model</span>
          <Select
            label={`${name} default model`}
            value={modelChoiceValue(status.models, defaults.model)}
            options={modelOptions}
            onSelect={(model) => void setProviderDefault(id, { model })}
            variant="field"
            size="md"
          />
        </div>
        <div className={styles.field}>
          <span className={section.label}>default mode</span>
          <Select
            label={`${name} default mode`}
            value={defaults.mode ?? "approval-required"}
            options={modeOptions}
            onSelect={(mode) => void setProviderDefault(id, { mode })}
            variant="field"
            size="md"
          />
        </div>
      </div>
    </article>
  );
}
