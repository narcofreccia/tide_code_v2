import {
  type Activity,
  type GitSettings,
  type InternalCommand,
  type Project,
  type ReadModel,
  type Thread,
} from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import type { SessionDirectory } from "../provider/sessions.ts";
import type { OneShotDeps } from "../rpc/oneShot.ts";
import type { SettingsStore } from "../settings.ts";
import { threadCwd } from "../provider/sessions.ts";
import { CheckpointService } from "./checkpoints.ts";
import { Git } from "./git.ts";
import type { GhLike } from "./gh.ts";
import type { MergeBack } from "./merge.ts";
import type { IntentJournal } from "./recovery.ts";
import { generateCommitMessage } from "./messages.ts";
import type { WorktreeManager } from "./worktrees.ts";

export type ReactorGitSettings = Pick<GitSettings, "pushThreadBranches" | "syncBaseWithRemote" | "pushBaseAfterMerge" | "generateMessages">;

export const GIT_OFF: ReactorGitSettings = {
  pushThreadBranches: "never",
  syncBaseWithRemote: false,
  pushBaseAfterMerge: false,
  generateMessages: false,
};

/** What the reactor's handler modules share: its dependencies and the per-thread state they read and write. */
export interface VcsEnv {
  engine: Engine;
  worktrees: WorktreeManager;
  checkpoints: CheckpointService;
  sessions: Pick<SessionDirectory, "close"> | undefined;
  gh: GhLike;
  git: (cwd: string) => Git;
  merge: MergeBack;
  onDetach: ((threadId: string, worktreePath: string) => void) | undefined;
  onPrChange: ((threadId: string) => void) | undefined;
  settings: Pick<SettingsStore, "get"> | undefined;
  oneShot: OneShotDeps | undefined;
  journal: IntentJournal | undefined;
  now: () => number;
  newId: () => string;
  log: (msg: string, data?: unknown) => void;
  /** threads whose last branch push failed: one activity per failure streak */
  pushMuted: Set<string>;
  /**
   * threadId -> why its worktree could not be created. While set, every turn of the thread is
   * refused with an error row (`refuseWithoutWorktree`): it never runs in the main checkout.
   * Cleared when a worktree attaches (a boot recovery retries creation) or the thread is deleted.
   */
  worktreeFailures: Map<string, string>;
  /** threadId -> how its worktree differs from what was asked; one row on its first turn */
  worktreeNotices: Map<string, { kind: "info" | "error"; text: string }>;
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function dispatch(env: VcsEnv, command: InternalCommand): Promise<void> {
  try {
    await env.engine.dispatch(command);
  } catch (err) {
    env.log(`[vcs] ${command.type} rejected`, err);
  }
}

export function threadContext(env: VcsEnv, threadId: string): { model: ReadModel; thread: Thread; project: Project; cwd: string } | undefined {
  const model = env.engine.getModel();
  const thread = model.threads[threadId];
  const project = thread ? model.projects[thread.projectId] : undefined;
  if (!thread || !project) return undefined;
  return { model, thread, project, cwd: threadCwd(thread, project) };
}

/** Posts a row on the thread's latest turn (only logged when it has none); `id` makes the row idempotent. */
export async function info(env: VcsEnv, threadId: string, kind: "info" | "error", text: string, id?: string): Promise<void> {
  const model = env.engine.getModel();
  const turnId = model.threads[threadId]?.latestTurnId;
  if (turnId === undefined) {
    env.log(`[vcs] ${kind}: ${text}`, threadId);
    return;
  }
  await post(env, threadId, turnId, kind, text, id);
}

/** Same, but on a turn the caller already holds (the before-checkpoint path). */
export async function post(env: VcsEnv, threadId: string, turnId: string, kind: "info" | "error", text: string, id?: string): Promise<void> {
  const at = env.now();
  const activity: Activity = { id: id ?? env.newId(), threadId, turnId, kind, text, createdAt: at, updatedAt: at };
  await dispatch(env, { type: "activity.upsert", activity });
}

export function gitSettings(env: VcsEnv): ReactorGitSettings {
  return env.settings?.get().git ?? GIT_OFF;
}

/** C5: generated text when the user wants it and a harness answers; undefined keeps the fallback. */
export async function generate(env: VcsEnv, input: Parameters<typeof generateCommitMessage>[1]): Promise<{ subject: string; body?: string } | undefined> {
  if (env.oneShot === undefined || !gitSettings(env).generateMessages) return undefined;
  return generateCommitMessage(env.oneShot, input);
}
