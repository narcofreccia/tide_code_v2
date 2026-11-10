import { useEffect, useRef, useState } from "react";
import type { InteractionMode, RuntimeMode, Thread } from "@tide/contracts";
import { createThread, type NewThreadOptions } from "../../lib/threadActions.ts";
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
import { effortsOf, providerStatus, useProviderRoster } from "../../state/providers.ts";
import { preferredProviderId } from "../../lib/preferredProvider.ts";
import { copyTerminalCommand } from "../../lib/threadActions.ts";
import { harnessProblem, runOrCopy, type HarnessProblem } from "../../lib/providerLogin.ts";
import { ThreadLinkPicker, useLinkChoices } from "./ThreadLinkPicker.tsx";
import { HarnessFields, draftForProvider, useThreadDraft } from "../thread/ProviderPicker.tsx";
import { useModel } from "../../state/model.ts";
import { useEnvOfflineReason } from "../../state/threadEnv.ts";
import { limitModeOptions, modeBlocked, useDeviceLimit } from "../../state/deviceAccess.ts";
import { useUi, type NewThreadTab } from "../../state/ui.ts";
import { NewTeamFields } from "./NewTeamFields.tsx";
import { environmentName } from "../../state/environments.ts";
import { call } from "../../state/model.ts";
import { envOpt, useMultiEnv } from "../fleet/envView.ts";
import { EnvSelect } from "../fleet/EnvSelect.tsx";
import { useRunOn } from "./useRunOn.ts";
import { Button } from "../ui/Button.tsx";
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

function InteractionSwitch({
  value,
  onChange,
  planMode,
}: {
  value: InteractionMode;
  onChange: (mode: InteractionMode) => void;
  /** the chosen harness has a native plan mode; Plan is offered only then */
  planMode: boolean;
}) {
  return (
    <div className={styles.segmented} role="radiogroup" aria-label="Interaction">
      {INTERACTION_MODES.filter((mode) => planMode || mode !== "plan").map((mode) => (
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

/**
 * The first pick is made before the roster may have answered; once it does, a pick the user has
 * not changed follows the better choice (a usable harness instead of the unusable default).
 */
function useRepickOnRoster(picked: string, current: string, repick: (id: string) => void): void {
  const initial = useRef(current);
  useEffect(() => {
    if (current !== initial.current || picked === current) return;
    initial.current = picked;
    repick(picked);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- repick is a fresh closure each render
  }, [picked, current]);
}

/** "Codex is not logged in · Log in": the fix next to the reason. */
function ProblemCaption({ problem }: { problem: HarnessProblem }) {
  const { command, url } = problem;
  return (
    <span className={styles.problem} role="status">
      {problem.reason}
      {command !== undefined ? (
        <>
          {" · "}
          <Button
            variant="link"
            onClick={() => void (problem.kind === "login" ? runOrCopy(command) : copyTerminalCommand(command))}
            title={command}
          >
            {problem.kind === "login" ? "Log in" : "Copy install command"}
          </Button>
        </>
      ) : null}
      {url !== undefined ? (
        <>
          {" · "}
          <a href={url} target="_blank" rel="noreferrer">
            Docs
          </a>
        </>
      ) : null}
    </span>
  );
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
  const { providers, error: rosterError } = useProviderRoster();
  const picked = preferredProviderId(providers, source === undefined ? undefined : providerIdOf(source));
  const [draft, patch] = useThreadDraft(
    picked,
    parent === undefined && last !== undefined && providerIdOf(last) === picked ? (last.model ?? "") : "",
    parent === undefined ? last?.mode : undefined,
  );
  useRepickOnRoster(picked, draft.providerId, (id) => patch(draftForProvider(id, providers)));
  const [title, setTitle] = useState("");
  const [interaction, setInteraction] = useState<InteractionMode>("default");
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const linkChoices = useLinkChoices(projectId);
  const project = useProjectTitle(projectId);
  const projectRecord = useModel((s) => (projectId === undefined ? undefined : s.model.projects[projectId]));
  const mode = draft.mode ?? FALLBACK_MODE;
  const harness = instanceLabel(providers, draft.providerId);
  const multiEnv = useMultiEnv();
  const runOn = useRunOn(parent === undefined ? projectId : undefined);
  const envId = parent === undefined ? runOn.target : runOn.owner;
  const status = providerStatus(providers, draft.providerId, envId) ?? providerStatus(providers, draft.providerId);
  const offline = useEnvOfflineReason(envId);
  // R19: on a machine where this device is limited, no Full access mode and no fresh clone
  const limit = useDeviceLimit(envId);
  const limited = modeBlocked(draft.mode, limit) ?? (runOn.plan.kind === "clone" ? limit : undefined);
  const efforts = effortsOf(status?.models ?? [], draft.model);
  // C1: Plan only where the harness has a native plan mode; an unknown (still loading) roster keeps it
  const planMode = status === undefined || status.caps.planMode === true;
  useEffect(() => {
    if (!planMode) setInteraction("default");
  }, [planMode]);
  const chosenInteraction: InteractionMode = planMode ? interaction : "default";
  // a harness that is known to be missing or signed out cannot run the first turn; unknown never blocks
  const problem = rosterError === null ? harnessProblem(status, harness) : undefined;
  const create = (): void => {
    if (!projectId || busy !== undefined || offline !== undefined || limited !== undefined || problem !== undefined) return;
    const trimmed = title.trim();
    const options: NewThreadOptions = {
      ...(parent === undefined ? {} : { parentThreadId: parent.id }),
      ...(trimmed === "" ? {} : { title: trimmed }),
      ...(draft.model === "" ? {} : { model: draft.model }),
      ...(draft.providerId === draft.provider ? {} : { providerId: draft.providerId }),
      ...(draft.effort === "" || !efforts.some((e) => e.id === draft.effort) ? {} : { effort: draft.effort }),
      ...(draft.mode === undefined ? {} : { mode: draft.mode }),
      ...(chosenInteraction === "default" ? {} : { interaction: chosenInteraction }),
      useWorktree: draft.useWorktree,
    };
    const plan = runOn.plan;
    if (plan.kind === "own") {
      onDone();
      const links = linkChoices.payload === undefined ? {} : { links: linkChoices.payload };
      runOrToast("Creating the thread", () => createThread(projectId, draft.provider, { ...options, ...links }));
      return;
    }
    const target = runOn.target;
    if (target === undefined) return;
    // R17 B3: another machine — its own clone of the repo (reused, adopted or cloned on the spot);
    // the project links belong to this checkout, so they stay behind
    if (plan.kind === "sibling") {
      onDone();
      runOrToast("Creating the thread", () => createThread(plan.project.id, draft.provider, { ...options, envId: target }));
      return;
    }
    const project = projectRecord;
    if (project === undefined) return;
    setBusy(`Cloning onto ${runOn.machine}…`);
    runOrToast("Creating the thread", async () => {
      try {
        const ensured = await call(
          "project.ensure",
          {
            repo: { remoteUrl: plan.repo.remoteUrl, cloneUrl: plan.repo.cloneUrl, defaultBranch: plan.repo.defaultBranch },
            title: project.title,
            ...(project.icon === undefined ? {} : { icon: project.icon }),
          },
          envOpt(target),
        );
        await createThread(ensured.projectId, draft.provider, { ...options, envId: target });
        onDone();
      } finally {
        setBusy(undefined);
      }
    });
  };
  const outcome =
    chosenInteraction === "plan"
      ? `Opens a thread on ${harness} in Plan mode: your first message gets a plan back, and nothing changes until you approve it.`
      : `Opens an idle thread on ${harness}; nothing runs until you send the first message.`;
  return (
    <DialogFrame
      heading={parent ? `Start a child thread in ${project}` : `Start a thread on ${project}`}
      {...(parent ? { context: `Child of “${parent.title}”` } : {})}
      {...(toolbar === undefined ? {} : { toolbar })}
      outcome={outcome}
      primaryLabel={busy ?? (parent ? "Create child thread" : "Create thread")}
      onPrimary={create}
      busy={busy !== undefined}
      blockedReason={projectId === undefined ? "Add a project first" : (offline ?? limited ?? problem?.reason)}
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
        {parent === undefined && runOn.pickable ? (
          <FrameField
            label="Runs on"
            caption={
              runOn.note === undefined ? (
                runOn.caption
              ) : (
                <>
                  {runOn.caption}
                  <br />
                  {runOn.note}
                </>
              )
            }
          >
            <EnvSelect label="Run on" value={runOn.target} onSelect={runOn.setTarget} />
          </FrameField>
        ) : multiEnv && envId !== undefined ? (
          <FrameField label="Runs on" caption="A thread runs on the machine that holds its project">
            <span className={styles.machine}>{environmentName(envId)}</span>
          </FrameField>
        ) : null}
        <FrameField
          label="Agent"
          caption={
            problem !== undefined ? (
              <ProblemCaption problem={problem} />
            ) : draft.model === "" ? (
              `Model: ${defaultModelHint(harness).toLowerCase()}`
            ) : undefined
          }
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
            options={limitModeOptions(MODE_OPTIONS, limit)}
            onSelect={(next) => patch({ mode: next })}
            variant="field"
            size="md"
            className={styles.narrow}
          />
        </FrameField>
        <FrameField label="Mode" caption={INTERACTION_HINTS[chosenInteraction]}>
          <InteractionSwitch value={chosenInteraction} onChange={setInteraction} planMode={planMode} />
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
      {runOn.plan.kind === "own" ? (
        <ThreadLinkPicker links={linkChoices.links} choices={linkChoices.choices} onChange={linkChoices.setChoices} />
      ) : null}
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
