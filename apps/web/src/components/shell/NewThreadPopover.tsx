import { useState } from "react";
import type { InteractionMode, RuntimeMode, Thread } from "@tide/contracts";
import { createThread } from "../../lib/threadActions.ts";
import { runOrToast } from "../../lib/dispatchOrToast.ts";
import {
  INTERACTION_HINTS,
  INTERACTION_LABELS,
  INTERACTION_MODES,
  RUNTIME_MODE_HINTS,
  RUNTIME_MODE_LABELS,
  RUNTIME_MODES,
  defaultModelHint,
  instanceLabel,
  providerIdOf,
} from "../../lib/vocab.ts";
import { EffortSelect } from "../thread/EffortSelect.tsx";
import { effortsOf, providerStatus, useProviders } from "../../state/providers.ts";
import { ThreadLinkPicker, useLinkChoices } from "./ThreadLinkPicker.tsx";
import { HarnessFields, useThreadDraft } from "../thread/ProviderPicker.tsx";
import { useModel } from "../../state/model.ts";
import { useUi, type NewThreadTab } from "../../state/ui.ts";
import { NewTeamFields } from "./NewTeamFields.tsx";
import { Checkbox } from "../ui/Choice.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { DialogFrame, FrameField, PrimaryField } from "../ui/DialogFrame.tsx";
import { Popover } from "../ui/Popover.tsx";
import { Select, type SelectOption } from "../ui/Select.tsx";
import styles from "./NewThreadPopover.module.css";

/** the server's mode when none is sent */
const FALLBACK_MODE: RuntimeMode = "approval-required";

const MODE_OPTIONS: SelectOption<RuntimeMode>[] = RUNTIME_MODES.map((mode) => ({
  value: mode,
  label: RUNTIME_MODE_LABELS[mode],
  title: RUNTIME_MODE_HINTS[mode],
}));

function InteractionSwitch({ value, onChange }: { value: InteractionMode; onChange: (mode: InteractionMode) => void }) {
  return (
    <div className={styles.segmented} role="radiogroup" aria-label="Interaction">
      {INTERACTION_MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={value === mode}
          title={INTERACTION_HINTS[mode]}
          className={`${styles.segment} ${value === mode ? styles.active : ""}`}
          onClick={() => onChange(mode)}
        >
          {INTERACTION_LABELS[mode]}
        </button>
      ))}
    </div>
  );
}

function lastCreated(threads: Record<string, Thread>, projectId: string | undefined): Thread | undefined {
  let best: Thread | undefined;
  for (const t of Object.values(threads)) {
    if (t.projectId !== projectId) continue;
    if (best === undefined || t.createdAt > best.createdAt) best = t;
  }
  return best;
}

function useProjectTitle(projectId: string | undefined): string {
  return useModel((s) => (projectId === undefined ? undefined : s.model.projects[projectId]?.title)) ?? "this project";
}

/**
 * title · agent · model · permissions · Build|Plan · worktree · links, then
 * create. Shared by the rail popover, Mission Control and the ⌘N dialog, so all
 * three ask exactly the same questions. `parentThreadId` makes it a child thread.
 */
function ThreadFields({
  projectId,
  parentThreadId,
  toolbar,
  onDone,
}: {
  projectId: string | undefined;
  parentThreadId?: string;
  toolbar?: React.ReactNode;
  onDone: () => void;
}) {
  const parent = useModel((s) => (parentThreadId === undefined ? undefined : s.model.threads[parentThreadId]));
  // a fresh thread starts from the project's most recently created one; Settings defaults otherwise
  const last = useModel((s) =>
    parentThreadId === undefined || projectId === undefined ? lastCreated(s.model.threads, projectId) : undefined,
  );
  const source = parent ?? last;
  const [draft, patch] = useThreadDraft(
    source === undefined ? "claude" : providerIdOf(source),
    parent === undefined ? (last?.model ?? "") : "",
    parent === undefined ? last?.mode : undefined,
  );
  const [title, setTitle] = useState("");
  const [interaction, setInteraction] = useState<InteractionMode>("default");
  const linkChoices = useLinkChoices(projectId);
  const project = useProjectTitle(projectId);
  const mode = draft.mode ?? FALLBACK_MODE;
  const providers = useProviders();
  const harness = instanceLabel(providers, draft.providerId);
  const efforts = effortsOf(providerStatus(providers, draft.providerId)?.models ?? [], draft.model);
  const create = (): void => {
    onDone();
    if (!projectId) return;
    const trimmed = title.trim();
    runOrToast("Creating the thread", () =>
      createThread(projectId, draft.provider, {
        ...(parent === undefined ? {} : { parentThreadId: parent.id }),
        ...(trimmed === "" ? {} : { title: trimmed }),
        ...(draft.model === "" ? {} : { model: draft.model }),
        ...(draft.providerId === draft.provider ? {} : { providerId: draft.providerId }),
        ...(draft.effort === "" || !efforts.some((e) => e.id === draft.effort) ? {} : { effort: draft.effort }),
        ...(draft.mode === undefined ? {} : { mode: draft.mode }),
        ...(interaction === "default" ? {} : { interaction }),
        useWorktree: draft.useWorktree,
        ...(linkChoices.payload === undefined ? {} : { links: linkChoices.payload }),
      }),
    );
  };
  const outcome =
    interaction === "plan"
      ? `Opens a thread on ${harness} in Plan mode: your first message gets a plan back, and nothing changes until you approve it.`
      : `Opens an idle thread on ${harness}; nothing runs until you send the first message.`;
  return (
    <DialogFrame
      heading={parent ? `Start a child thread in ${project}` : `Start a thread on ${project}`}
      {...(parent ? { context: `Child of “${parent.title}”` } : {})}
      {...(toolbar === undefined ? {} : { toolbar })}
      outcome={outcome}
      primaryLabel={parent ? "Create child thread" : "Create thread"}
      onPrimary={create}
      blockedReason={projectId === undefined ? "Add a project first" : undefined}
      onCancel={onDone}
    >
      <PrimaryField
        label="Title"
        ariaLabel="Thread title"
        placeholder="Fix the flaky login test"
        caption="Optional. Named from your first message otherwise."
        value={title}
        onChange={setTitle}
        onEnter={create}
      />
      <div className={styles.rows}>
        <FrameField
          label="Agent"
          caption={draft.model === "" ? `Model: ${defaultModelHint(harness).toLowerCase()}` : undefined}
        >
          <HarnessFields
            layout="inline"
            name="Thread"
            provider={draft.provider}
            providerId={draft.providerId}
            model={draft.model}
            onChange={patch}
            instances="all"
          />
        </FrameField>
        {efforts.length === 0 ? null : (
          <FrameField label="Effort" caption="How hard the model thinks before answering">
            <EffortSelect
              label="Thread effort"
              efforts={efforts}
              value={draft.effort}
              onSelect={(effort) => patch({ effort })}
              variant="field"
              className={styles.narrow}
            />
          </FrameField>
        )}
        <FrameField label="Permissions" caption={RUNTIME_MODE_HINTS[mode]}>
          <Select
            label="Thread permissions"
            value={mode}
            options={MODE_OPTIONS}
            onSelect={(next) => patch({ mode: next })}
            variant="field"
            size="md"
            className={styles.narrow}
          />
        </FrameField>
        <FrameField label="Mode" caption={INTERACTION_HINTS[interaction]}>
          <InteractionSwitch value={interaction} onChange={setInteraction} />
        </FrameField>
        <FrameField
          label="Checkout"
          caption={
            draft.useWorktree
              ? "Its own worktree on a tide/* branch; merge back when it is done."
              : "Works directly in the project folder, alongside you."
          }
        >
          <Checkbox
            className={styles.check}
            checked={draft.useWorktree}
            onChange={(e) => patch({ useWorktree: e.target.checked })}
          >
            Use a worktree
          </Checkbox>
        </FrameField>
      </div>
      <ThreadLinkPicker links={linkChoices.links} choices={linkChoices.choices} onChange={linkChoices.setChoices} />
    </DialogFrame>
  );
}

function TabSwitch({ value, onChange }: { value: NewThreadTab; onChange: (tab: NewThreadTab) => void }) {
  return (
    <div className={styles.segmented} role="radiogroup" aria-label="Kind">
      {(["thread", "team"] as const).map((tab) => (
        <button
          key={tab}
          type="button"
          role="radio"
          aria-checked={value === tab}
          className={`${styles.segment} ${value === tab ? styles.active : ""}`}
          onClick={() => onChange(tab)}
        >
          {tab === "thread" ? "Thread" : "Team"}
        </button>
      ))}
    </div>
  );
}

/**
 * The new-thread form with its Thread | Team switch. A child thread has no Team
 * side: a team run always starts a fresh lead.
 */
export function NewThreadFields({
  projectId,
  parentThreadId,
  initialTab = "thread",
  onDone,
}: {
  projectId: string | undefined;
  parentThreadId?: string;
  initialTab?: NewThreadTab;
  onDone: () => void;
}) {
  const [tab, setTab] = useState<NewThreadTab>(parentThreadId === undefined ? initialTab : "thread");
  const toolbar = parentThreadId === undefined ? <TabSwitch value={tab} onChange={setTab} /> : undefined;
  return tab === "team" ? (
    <NewTeamFields projectId={projectId} onDone={onDone} toolbar={toolbar} />
  ) : (
    <ThreadFields
      projectId={projectId}
      {...(parentThreadId === undefined ? {} : { parentThreadId })}
      {...(toolbar === undefined ? {} : { toolbar })}
      onDone={onDone}
    />
  );
}

/** The anchored form the rail and Mission Control open. */
export function NewThreadPopover({
  projectId,
  label = "New thread",
  variant = "ghost",
  align = "start",
}: {
  projectId: string | undefined;
  label?: string;
  variant?: "primary" | "ghost" | "quiet";
  align?: "start" | "end";
}) {
  return (
    <Popover label={label} variant={variant} align={align} disabled={projectId === undefined} flush>
      {(close) => <NewThreadFields projectId={projectId} onDone={close} />}
    </Popover>
  );
}

/** The same form as a modal, raised by `⌘N`, the palette, the rail menu and `+ child`. */
export function NewThreadDialogHost() {
  const projectId = useUi((s) => s.newThreadProjectId);
  const parentThreadId = useUi((s) => s.newThreadParentId);
  const initialTab = useUi((s) => s.newThreadTab);
  const setNewThreadProject = useUi((s) => s.setNewThreadProject);
  if (projectId === null) return null;
  return (
    <Dialog
      title={parentThreadId ? "New child thread" : "New thread"}
      onCancel={() => setNewThreadProject(null)}
      variant="sheet"
    >
      <NewThreadFields
        key={`${projectId}:${parentThreadId ?? ""}`}
        projectId={projectId}
        {...(parentThreadId === null ? {} : { parentThreadId })}
        initialTab={initialTab}
        onDone={() => setNewThreadProject(null)}
      />
    </Dialog>
  );
}
