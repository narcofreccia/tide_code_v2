import { useState } from "react";
import type { InteractionMode, RuntimeMode } from "@tide/contracts";
import { createThread } from "../../lib/threadActions.ts";
import { runOrToast } from "../../lib/dispatchOrToast.ts";
import {
  INTERACTION_HINTS,
  INTERACTION_LABELS,
  INTERACTION_MODES,
  RUNTIME_MODE_HINTS,
  RUNTIME_MODE_LABELS,
  RUNTIME_MODES,
} from "../../lib/vocab.ts";
import { ThreadLinkPicker, useLinkChoices } from "./ThreadLinkPicker.tsx";
import { ProviderPicker, useThreadDraft } from "../thread/ProviderPicker.tsx";
import { useModel } from "../../state/model.ts";
import { useUi, type NewThreadTab } from "../../state/ui.ts";
import { NewTeamFields } from "./NewTeamFields.tsx";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
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

/**
 * title · provider · model · permissions · Build|Plan · worktree · links, then
 * create. Shared by the rail popover, Mission Control and the ⌘N dialog, so all
 * three ask exactly the same questions. `parentThreadId` makes it a child thread.
 */
function ThreadFields({
  projectId,
  parentThreadId,
  onDone,
}: {
  projectId: string | undefined;
  parentThreadId?: string;
  onDone: () => void;
}) {
  const parent = useModel((s) => (parentThreadId === undefined ? undefined : s.model.threads[parentThreadId]));
  const [draft, patch] = useThreadDraft(parent?.provider ?? "claude");
  const [title, setTitle] = useState("");
  const [interaction, setInteraction] = useState<InteractionMode>("default");
  const linkChoices = useLinkChoices(projectId);
  const create = (): void => {
    onDone();
    if (!projectId) return;
    const trimmed = title.trim();
    runOrToast("Creating the thread", () =>
      createThread(projectId, draft.provider, {
        ...(parent === undefined ? {} : { parentThreadId: parent.id }),
        ...(trimmed === "" ? {} : { title: trimmed }),
        ...(draft.model === "" ? {} : { model: draft.model }),
        ...(draft.mode === undefined ? {} : { mode: draft.mode }),
        ...(interaction === "default" ? {} : { interaction }),
        useWorktree: draft.useWorktree,
        ...(linkChoices.payload === undefined ? {} : { links: linkChoices.payload }),
      }),
    );
  };
  return (
    <>
      {parent ? <p className={styles.parent}>Child of “{parent.title}”</p> : null}
      <label className={styles.field}>
        <span className={styles.label}>title</span>
        <input
          className={`${styles.input} ${styles.titleInput}`}
          aria-label="Thread title"
          placeholder="Auto from your first message"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              create();
            }
          }}
        />
      </label>
      <ProviderPicker draft={draft} onChange={patch} />
      <div className={styles.field}>
        <span className={styles.label}>permissions</span>
        <Select
          label="Thread permissions"
          value={draft.mode ?? FALLBACK_MODE}
          options={MODE_OPTIONS}
          onSelect={(mode) => patch({ mode })}
          variant="field"
          size="md"
        />
      </div>
      <div className={styles.field}>
        <span className={styles.label}>mode</span>
        <InteractionSwitch value={interaction} onChange={setInteraction} />
      </div>
      <ThreadLinkPicker
        links={linkChoices.links}
        choices={linkChoices.choices}
        onChange={linkChoices.setChoices}
      />
      <Button variant="primary" onClick={create}>
        {parent ? "Create child thread" : "Create thread"}
      </Button>
    </>
  );
}

function TabSwitch({ value, onChange }: { value: NewThreadTab; onChange: (tab: NewThreadTab) => void }) {
  return (
    <div className={`${styles.segmented} ${styles.tabs}`} role="radiogroup" aria-label="Kind">
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
  return (
    <>
      {parentThreadId === undefined ? <TabSwitch value={tab} onChange={setTab} /> : null}
      {tab === "team" ? (
        <NewTeamFields projectId={projectId} onDone={onDone} />
      ) : (
        <ThreadFields
          projectId={projectId}
          {...(parentThreadId === undefined ? {} : { parentThreadId })}
          onDone={onDone}
        />
      )}
    </>
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
    <Popover label={label} variant={variant} align={align} disabled={projectId === undefined}>
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
    <Dialog title={parentThreadId ? "New child thread" : "New thread"} onCancel={() => setNewThreadProject(null)}>
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
