import { useState } from "react";
import type { ProviderInstanceConfig, ProviderKind } from "@tide/contracts";
import { PROVIDER_LABELS } from "../../../lib/vocab.ts";
import { Dialog } from "../../ui/Dialog.tsx";
import { DialogFrame, FrameField, PrimaryField } from "../../ui/DialogFrame.tsx";
import styles from "./Providers.module.css";
import { configFromDraft, draftOf, draftProblem, instanceId, type InstanceDraft } from "./instances.ts";

/** Where each harness reads its account from; `home` is mapped to this by the server. */
const HOME_VARIABLE: Record<ProviderKind, string> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  opencode: "HOME",
  pi: "HOME",
  acp: "HOME",
};

/**
 * The fields of one instance as a composition frame. A bundled kind asks for a home
 * directory, env and binary; a manual ACP agent for its command and args; an ACP
 * agent from the registry only for its name and env (its launch is the registry's).
 */
export function InstanceFields({
  kind,
  instance,
  taken,
  manual,
  onSave,
  onCancel,
}: {
  kind: ProviderKind;
  /** set: editing this instance */
  instance?: ProviderInstanceConfig | undefined;
  /** ids already in use, for a new id */
  taken: readonly string[];
  /** acp only: launched by `command` + `args` rather than a registry id */
  manual: boolean;
  onSave: (config: ProviderInstanceConfig) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<InstanceDraft>(() => draftOf(instance));
  const set = (patch: Partial<InstanceDraft>): void => setDraft((d) => ({ ...d, ...patch }));
  const acp = kind === "acp";
  const problem = draftProblem(draft, kind, manual);
  const harness = PROVIDER_LABELS[kind];
  const id = instance?.id ?? instanceId(kind, draft.label, taken);
  const save = (): void => {
    if (problem !== undefined) return;
    onSave(configFromDraft({ id, kind, ...(instance?.acpAgentId === undefined ? {} : { acpAgentId: instance.acpAgentId }) }, draft));
  };
  const heading = instance
    ? `Edit ${instance.label}`
    : acp
      ? "Add an ACP agent by its command"
      : `Add a ${harness} account`;
  const outcome = instance
    ? "Threads on it pick the change up from their next session."
    : acp
      ? "The agent shows up under ACP agents in every Agent picker."
      : `A second ${harness} login: threads can run on it next to the default one.`;
  return (
    <DialogFrame
      heading={heading}
      context={instance ? `id ${instance.id}` : `id ${id}`}
      outcome={outcome}
      primaryLabel={instance ? "Save" : "Add"}
      onPrimary={save}
      blockedReason={problem}
      onCancel={onCancel}
    >
      <PrimaryField
        label="Name"
        ariaLabel="Instance name"
        placeholder={acp ? "Gemini CLI" : `${harness} · work`}
        value={draft.label}
        onChange={(label) => set({ label })}
        onEnter={save}
      />
      {acp ? (
        manual || instance?.command !== undefined ? (
          <>
            <FrameField label="Command" caption="The executable that speaks ACP over stdio">
              <input className={styles.input} aria-label="Command" placeholder="npx" value={draft.command} onChange={(e) => set({ command: e.target.value })} />
            </FrameField>
            <FrameField label="Arguments" caption="Separated by spaces; quote one that contains spaces">
              <input className={styles.input} aria-label="Arguments" placeholder="-y @google/gemini-cli --experimental-acp" value={draft.args} onChange={(e) => set({ args: e.target.value })} />
            </FrameField>
          </>
        ) : null
      ) : (
        <>
          <FrameField label="Home" caption={`Its own config directory (${HOME_VARIABLE[kind]}); log in there once with ${harness}'s own command`}>
            <input className={styles.input} aria-label="Home directory" placeholder={`~/.${kind}-work`} value={draft.home} onChange={(e) => set({ home: e.target.value })} />
          </FrameField>
          <FrameField label="Binary" caption="Optional. A different install of the CLI">
            <input className={styles.input} aria-label="Binary path" placeholder={`/usr/local/bin/${kind}`} value={draft.binaryPath} onChange={(e) => set({ binaryPath: e.target.value })} />
          </FrameField>
        </>
      )}
      <FrameField label="Environment" caption="KEY=VALUE per line (API keys, model overrides). Stored in Tide's settings on this machine">
        <textarea
          className={styles.area}
          aria-label="Environment"
          spellCheck={false}
          placeholder={acp ? "GEMINI_API_KEY=…" : "ANTHROPIC_BASE_URL=…"}
          value={draft.env}
          onChange={(e) => set({ env: e.target.value })}
        />
      </FrameField>
    </DialogFrame>
  );
}

/** {@link InstanceFields} in a sheet. */
export function InstanceDialog(props: React.ComponentProps<typeof InstanceFields>) {
  const title = props.instance ? `Edit ${props.instance.label}` : props.kind === "acp" ? "Add ACP agent" : `Add ${PROVIDER_LABELS[props.kind]} account`;
  return (
    <Dialog title={title} onCancel={props.onCancel} variant="sheet">
      <InstanceFields {...props} />
    </Dialog>
  );
}
