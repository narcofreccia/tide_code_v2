import type { ProviderKind, ProviderStatusDto } from "@tide/contracts";
import { PROVIDERS } from "../../lib/vocab.ts";
import { loadProviders, providerStatus, useProviders, useProvidersStore } from "../../state/providers.ts";
import { Button } from "../ui/Button.tsx";
import { ProviderCard } from "./ProviderCard.tsx";
import section from "./Section.module.css";
import styles from "./ProvidersSection.module.css";

/** A kind the server did not report at all still gets a card, so the set is stable. */
function placeholder(kind: ProviderKind): ProviderStatusDto {
  return {
    kind,
    installed: false,
    loggedIn: false,
    hint: "driver not available in this build",
    models: [],
    caps: {
      planMode: false, subagents: false, mcp: false, images: false,
      resume: false, contextUsage: false, openInTerminal: false,
    },
  };
}

/** The four harnesses, always in the same order, data-driven by `providers.list`. */
export function ProvidersSection() {
  const providers = useProviders();
  const loading = useProvidersStore((s) => s.loading);
  const error = useProvidersStore((s) => s.error);

  return (
    <div className={section.section}>
      <div className={section.head}>
        <h3 className={section.title}>Providers</h3>
        <Button onClick={() => loadProviders(true)} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh all"}
        </Button>
      </div>
      <p className={section.note}>
        Tide drives the CLIs you already pay for. Log in with each tool&rsquo;s own command; Tide
        never stores provider credentials.
      </p>
      {error ? <p className={section.note}>Could not read harness status: {error}</p> : null}
      <div className={styles.cards}>
        {PROVIDERS.map((kind) => (
          <ProviderCard key={kind} status={providerStatus(providers, kind) ?? placeholder(kind)} />
        ))}
      </div>
    </div>
  );
}
