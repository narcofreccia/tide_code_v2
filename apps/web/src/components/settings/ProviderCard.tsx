import type { ProviderStatusDto } from "@tide/contracts";
import { PROVIDER_LABELS, RUNTIME_MODES } from "../../lib/vocab.ts";
import { copyTerminalCommand } from "../../lib/threadActions.ts";
import { loadProviders } from "../../state/providers.ts";
import { useProviderDefaults } from "../../state/settings.ts";
import { createPty, setDrawerOpen, writePty } from "../../state/terminals.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { Pill } from "../ui/Pill.tsx";
import { Select, type SelectOption } from "../ui/Select.tsx";
import section from "./Section.module.css";
import styles from "./ProviderCard.module.css";

const CAPS: { key: keyof ProviderStatusDto["caps"]; label: string }[] = [
  { key: "planMode", label: "plan mode" },
  { key: "subagents", label: "sub-agents" },
  { key: "mcp", label: "MCP" },
  { key: "images", label: "images" },
  { key: "resume", label: "resume" },
  { key: "contextUsage", label: "context usage" },
  { key: "openInTerminal", label: "open in terminal" },
];

/** `○ not installed · ◐ installed, logged out · ● ready` */
export function statusOf(p: ProviderStatusDto): { glyph: string; text: string; tone: string } {
  if (!p.installed) return { glyph: "○", text: "Not installed", tone: "off" };
  if (!p.loggedIn) return { glyph: "◐", text: "Installed · not logged in", tone: "warn" };
  const version = p.version ? ` · v${p.version.replace(/^v/, "")}` : "";
  return { glyph: "●", text: `Installed · logged in${version}`, tone: "ok" };
}

/** Drivers put their login command in the hint, backticked ("Run `claude auth login`"). */
export function loginCommand(hint: string | undefined): string | undefined {
  return hint?.match(/`([^`]+)`/)?.[1];
}

/** Runs the command in a new terminal of the selected thread, else copies it. */
async function runOrCopy(command: string): Promise<void> {
  const threadId = useUi.getState().selectedThreadId;
  if (!threadId) return copyTerminalCommand(command);
  const ptyId = await createPty(threadId, 80, 24);
  if (!ptyId) return copyTerminalCommand(command);
  setDrawerOpen(true);
  writePty(ptyId, `${command}\n`);
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
      <summary>{status.models.length} models</summary>
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

/** One harness: status, login affordance, capabilities, models and per-provider defaults. */
export function ProviderCard({ status }: { status: ProviderStatusDto }) {
  const kind = status.kind;
  const defaults = useProviderDefaults((s) => s.defaults[kind]) ?? {};
  const setProviderDefault = useProviderDefaults((s) => s.setProviderDefault);
  const threadId = useUi((s) => s.selectedThreadId);
  const { glyph, text, tone } = statusOf(status);
  const command = loginCommand(status.hint);
  const modelOptions: SelectOption<string>[] = [
    { value: "", label: "harness default" },
    ...status.models.map((m) => ({ value: m.id, label: m.label })),
  ];

  return (
    <article className={styles.card} aria-label={PROVIDER_LABELS[kind]}>
      <header className={styles.head}>
        <h4 className={styles.name}>{PROVIDER_LABELS[kind]}</h4>
        <Button variant="quiet" onClick={() => loadProviders(true)} title={`Re-probe ${kind}`}>
          Refresh
        </Button>
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

      <ul className={styles.caps} aria-label={`${PROVIDER_LABELS[kind]} capabilities`}>
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
        <label className={styles.field}>
          <span className={section.label}>default model</span>
          <Select
            label={`${PROVIDER_LABELS[kind]} default model`}
            value={defaults.model ?? ""}
            options={modelOptions}
            onSelect={(model) => setProviderDefault(kind, { model })}
          />
        </label>
        <label className={styles.field}>
          <span className={section.label}>default mode</span>
          <Select
            label={`${PROVIDER_LABELS[kind]} default mode`}
            value={defaults.mode ?? "approval-required"}
            options={RUNTIME_MODES}
            onSelect={(mode) => setProviderDefault(kind, { mode })}
          />
        </label>
      </div>
    </article>
  );
}
