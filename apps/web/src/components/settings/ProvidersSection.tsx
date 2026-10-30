import { useState } from "react";
import type { ProviderInstanceConfig, ProviderKind, ProviderStatusDto } from "@tide/contracts";
import { BUNDLED_PROVIDERS } from "../../lib/vocab.ts";
import { loadProviders, orderedInstances, placeholderStatus, useProviders, useProvidersStore } from "../../state/providers.ts";
import { setProviderInstances, useServerSettings } from "../../state/serverSettings.ts";
import { showToast } from "../../state/toast.ts";
import { Button } from "../ui/Button.tsx";
import { ConfirmDialog } from "../ui/Dialog.tsx";
import { ProviderCard } from "./ProviderCard.tsx";
import { AcpRegistryDialog } from "./providers/AcpRegistryDialog.tsx";
import { InstanceDialog } from "./providers/InstanceDialog.tsx";
import section from "./Section.module.css";
import styles from "./ProvidersSection.module.css";

type Sheet =
  | { type: "account"; kind: ProviderKind; instance?: ProviderInstanceConfig }
  | { type: "acp" }
  | { type: "remove"; instance: ProviderInstanceConfig }
  | null;

/**
 * Every instance as a card: the bundled harnesses (always, in a fixed order), then
 * added accounts, then ACP agents. A configured instance the server has not probed
 * yet still gets a card, so a fresh add shows at once.
 */
function cardsOf(providers: readonly ProviderStatusDto[], configured: readonly ProviderInstanceConfig[]): ProviderStatusDto[] {
  const known = orderedInstances(providers);
  const missing = configured
    .filter((c) => !known.some((p) => p.id === c.id))
    .map((c) => ({ ...placeholderStatus(c.kind, c.id, c.label), hint: "Not probed yet — Refresh" }));
  return orderedInstances([...known, ...missing]);
}

export function ProvidersSection() {
  const providers = useProviders();
  const loading = useProvidersStore((s) => s.loading);
  const error = useProvidersStore((s) => s.error);
  const configured = useServerSettings((s) => s.settings.providerInstances);
  const [sheet, setSheet] = useState<Sheet>(null);
  const taken = configured.map((c) => c.id);

  /** Replaces the list, then re-probes so the new instance's status and models show. */
  const save = (next: ProviderInstanceConfig[], message: string): void => {
    setSheet(null);
    void setProviderInstances(next).then(() => {
      // a refusal already toasted and rolled back; only a stored list is announced
      const stored = useServerSettings.getState().settings.providerInstances.map((c) => c.id).join("\n");
      if (stored !== next.map((c) => c.id).join("\n")) return;
      showToast(message);
      loadProviders(true);
    });
  };
  const upsert = (config: ProviderInstanceConfig): void => {
    const exists = configured.some((c) => c.id === config.id);
    save(
      exists ? configured.map((c) => (c.id === config.id ? config : c)) : [...configured, config],
      exists ? `Saved ${config.label}` : `Added ${config.label}`,
    );
  };

  return (
    <div className={section.section}>
      <div className={section.head}>
        <h3 className={section.title}>Providers</h3>
        <span className={styles.actions}>
          <Button onClick={() => setSheet({ type: "acp" })}>Add ACP agent…</Button>
          <Button onClick={() => loadProviders(true)} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh all"}
          </Button>
        </span>
      </div>
      <p className={section.note}>
        Tide drives the CLIs you already pay for. Log in with each tool&rsquo;s own command; Tide
        never stores provider credentials. Add a second account of a harness, or any agent that
        speaks the Agent Client Protocol.
      </p>
      {error ? <p className={section.note}>Could not read harness status: {error}</p> : null}
      <div className={styles.cards}>
        {cardsOf(providers, configured).map((status) => {
          const instance = configured.find((c) => c.id === status.id);
          const bundled = status.id === status.kind && BUNDLED_PROVIDERS.includes(status.kind);
          return (
            <ProviderCard
              key={status.id}
              status={status}
              instance={instance}
              onAddAccount={bundled ? () => setSheet({ type: "account", kind: status.kind }) : undefined}
              onEdit={instance ? () => setSheet({ type: "account", kind: instance.kind, instance }) : undefined}
              onRemove={instance ? () => setSheet({ type: "remove", instance }) : undefined}
            />
          );
        })}
      </div>
      {sheet?.type === "account" ? (
        <InstanceDialog
          kind={sheet.kind}
          instance={sheet.instance}
          manual={sheet.instance?.command !== undefined}
          taken={taken}
          onSave={upsert}
          onCancel={() => setSheet(null)}
        />
      ) : null}
      {sheet?.type === "acp" ? (
        <AcpRegistryDialog taken={taken} onAdd={upsert} onCancel={() => setSheet(null)} />
      ) : null}
      {sheet?.type === "remove" ? (
        <ConfirmDialog
          title={`Remove ${sheet.instance.label}?`}
          body="Threads on it stay, but cannot run until you switch their agent. Its login files are left on disk."
          confirmLabel="Remove"
          danger
          onConfirm={() => save(configured.filter((c) => c.id !== sheet.instance.id), `Removed ${sheet.instance.label}`)}
          onCancel={() => setSheet(null)}
        />
      ) : null}
    </div>
  );
}
