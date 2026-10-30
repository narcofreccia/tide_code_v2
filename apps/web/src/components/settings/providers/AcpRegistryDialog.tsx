import { useEffect, useState } from "react";
import type { AcpRegistryAgent, ProviderInstanceConfig } from "@tide/contracts";
import { call } from "../../../state/model.ts";
import { errorText } from "../../../lib/dispatchOrToast.ts";
import { Button } from "../../ui/Button.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { DialogFrame } from "../../ui/DialogFrame.tsx";
import { Pill } from "../../ui/Pill.tsx";
import styles from "./Providers.module.css";
import { InstanceFields } from "./InstanceDialog.tsx";
import { instanceId } from "./instances.ts";

const DISTRIBUTION_LABELS: Record<AcpRegistryAgent["distribution"], string> = {
  npx: "npx",
  uvx: "uvx",
  binary: "binary",
  none: "no build",
};

/** Tide can launch it as-is: a package runner fetches it on first use. */
export function launchable(agent: AcpRegistryAgent): boolean {
  return agent.distribution === "npx" || agent.distribution === "uvx";
}

/** A registry entry as a stored instance: `acp:<agentId>`, unique. */
export function instanceFromAgent(agent: AcpRegistryAgent, taken: readonly string[]): ProviderInstanceConfig {
  const base = `acp:${agent.id}`;
  const id = taken.includes(base) ? instanceId("acp", agent.id, taken) : base;
  return { id, kind: "acp", label: agent.name, acpAgentId: agent.id };
}

interface Registry {
  agents: AcpRegistryAgent[];
  fetchedAt?: number;
  loading: boolean;
  error?: string;
}

function AgentRow({ agent, onAdd }: { agent: AcpRegistryAgent; onAdd: () => void }) {
  const ok = launchable(agent);
  const meta = [agent.version ? `v${agent.version.replace(/^v/, "")}` : undefined, agent.license].filter(Boolean).join(" · ");
  return (
    <li className={styles.agent} aria-label={agent.name}>
      <div className={styles.agentText}>
        <span className={styles.agentName}>
          <span className={styles.value}>{agent.name}</span>
          <Pill tone={ok ? "accent" : "muted"}>{DISTRIBUTION_LABELS[agent.distribution]}</Pill>
          {meta === "" ? null : <span className={styles.agentMeta}>{meta}</span>}
        </span>
        {agent.description ? <span className={styles.agentDescription}>{agent.description}</span> : null}
      </div>
      <div className={styles.agentAction}>
        {agent.configured ? (
          <Pill tone="ok">added</Pill>
        ) : (
          <Button onClick={onAdd} disabled={!ok} aria-label={`Add ${agent.name}`}>
            Add
          </Button>
        )}
        {!ok && !agent.configured ? <span className={styles.agentWhy}>needs a manual command</span> : null}
      </div>
    </li>
  );
}

/**
 * The public ACP registry (`providers.acpRegistry`): add an agent in one click when
 * it ships through npx/uvx; anything else goes through "Manual…" (command + args).
 */
export function AcpRegistryDialog({
  taken,
  onAdd,
  onCancel,
}: {
  taken: readonly string[];
  onAdd: (config: ProviderInstanceConfig) => void;
  onCancel: () => void;
}) {
  const [registry, setRegistry] = useState<Registry>({ agents: [], loading: true });
  const [manual, setManual] = useState(false);

  const load = (refresh: boolean): void => {
    setRegistry((r) => ({ ...r, loading: true }));
    call("providers.acpRegistry", refresh ? { refresh: true } : {})
      .then((answer) => setRegistry({ agents: answer.agents, loading: false, ...(answer.fetchedAt === undefined ? {} : { fetchedAt: answer.fetchedAt }) }))
      .catch((error: unknown) => setRegistry((r) => ({ ...r, loading: false, error: errorText(error) })));
  };
  useEffect(() => load(false), []);

  if (manual) {
    return (
      <Dialog title="Add ACP agent" onCancel={onCancel} variant="sheet">
        <InstanceFields kind="acp" manual taken={taken} onSave={onAdd} onCancel={() => setManual(false)} />
      </Dialog>
    );
  }

  const fetched = registry.fetchedAt === undefined ? "bundled snapshot" : `fetched ${new Date(registry.fetchedAt).toLocaleString()}`;
  return (
    <Dialog title="Add ACP agent" onCancel={onCancel} variant="sheet">
      <DialogFrame
        heading="Add an agent that speaks the Agent Client Protocol"
        context={registry.loading ? "Reading the ACP registry…" : `${registry.agents.length} agents · ${fetched}`}
        toolbar={
          <>
            <Button onClick={() => load(true)} disabled={registry.loading}>
              {registry.loading ? "Refreshing…" : "Refresh"}
            </Button>
            <Button onClick={() => setManual(true)}>Manual…</Button>
          </>
        }
        outcome="An added agent runs in its own threads like any harness; log in with its own CLI when it asks."
        primaryLabel="Done"
        onPrimary={onCancel}
      >
        {registry.error ? <p className={styles.note}>Could not read the registry: {registry.error}</p> : null}
        <ul className={styles.agents} aria-label="ACP registry">
          {registry.agents.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent.configured || taken.includes(`acp:${agent.id}`) ? { ...agent, configured: true } : agent}
              onAdd={() => onAdd(instanceFromAgent(agent, taken))} />
          ))}
        </ul>
      </DialogFrame>
    </Dialog>
  );
}
