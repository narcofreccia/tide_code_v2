import { existsSync, realpathSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { InternalCommand, Project, ReadModel } from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import type { Git } from "./git.ts";
import type { MergeBack } from "./merge.ts";
import { sweepOrphanCheckpointRefs } from "./refSweep.ts";
import { findLandedSquash } from "./squashLanded.ts";
import type { WorktreeManager } from "./worktrees.ts";

/**
 * Boot-time reconciliation of the git side (R18 B1/B2). The live VCS reactor answers intents
 * (`merge.requested`, `thread.created` with a worktree, publish, detach) with git work and an
 * internal command; when the process dies in between, nobody answers. This pass runs once at
 * boot, before clients connect, on the reactor's own per-thread queues:
 *
 *   per project, in parallel, each bounded by `projectTimeoutMs`:
 *     1. `git worktree prune` (on the project's worktree lock)
 *     2. merges stuck on `merging`: scratch merge worktree removed, outcome inferred, `merge.report`
 *     3. worktrees wanted but never attached: orphan adopted, or created like `thread.created` does
 *        (a failure refuses the thread's turns, as live); a thread that already ran turns in the
 *        main checkout (before turns were refused) gets one warning row instead
 *   then, once:
 *     4. publish / detach intents the journal says were cut short: an info row (archive-detach is redone)
 *     5. unreferenced, unregistered, empty `tide/*` worktree directories removed; anything else logged and kept
 *     6. checkpoint refs of threads the log knew and the model no longer has (deleted mid-crash) removed
 */

export const MERGE_RESTART_ERROR = "interrupted by a server restart; check the base branch and merge again";
/** Prefix of the live reactor's "worktree could not be created" row; recovery does not warn twice. */
export const WORKTREE_FAILURE_PREFIX = "Worktree could not be created";
export const MAIN_CHECKOUT_WARNING =
  "This thread was meant to run in its own worktree, but the server stopped before the worktree was created: it has been running in the project's main checkout. Nothing was moved; start a new thread for worktree isolation.";

const DEFAULT_PROJECT_TIMEOUT_MS = 20_000;

export type IntentKind = "publish" | "detach" | "archive" | "merge";
export interface Intent {
  threadId: string;
  kind: IntentKind;
  /** merge: the base branch head when the local merge started (after any sync from origin) */
  baseSha?: string;
  /** merge: the commit the base was moved to, written as soon as the merge returned */
  landed?: string;
}

/**
 * Publish / detach / archive-detach intents in flight, persisted (one meta value) so a crash
 * leaves a trace: these intents leave no state in the read model, so without it a lost one is
 * invisible. Entries present at construction belong to the previous process.
 */
export class IntentJournal {
  #entries: Map<string, Intent>;
  #previous: [string, Intent][];
  #save: (value: string) => void;

  constructor(store: { load(): string | undefined; save(value: string): void }) {
    this.#save = store.save;
    let parsed: Record<string, Intent> = {};
    try {
      const raw = store.load();
      if (raw !== undefined && raw !== "") parsed = JSON.parse(raw) as Record<string, Intent>;
    } catch {
      parsed = {};
    }
    this.#entries = new Map(Object.entries(parsed));
    this.#previous = [...this.#entries];
  }

  begin(key: string, intent: Intent): void {
    this.#entries.set(key, intent);
    this.#persist();
  }

  end(key: string): void {
    if (this.#entries.delete(key)) this.#persist();
  }

  /** Intents the previous process never finished. */
  lost(): [string, Intent][] {
    return this.#previous;
  }

  #persist(): void {
    try {
      this.#save(JSON.stringify(Object.fromEntries(this.#entries)));
    } catch {
      // the journal is a hint for the next boot; never fail live work over it
    }
  }
}

export interface VcsRecoveryDeps {
  engine: Engine;
  worktrees: WorktreeManager;
  merge: MergeBack;
  git: (cwd: string) => Git;
  /** the reactor's per-thread queue */
  exclusive: <T>(threadId: string, task: () => Promise<T>) => Promise<T>;
  /** the live `thread.created` path; resolves to the failure reason, undefined when attached */
  createWorktree: (threadId: string, startRef?: string) => Promise<string | undefined>;
  /** the live path's failure state: the thread's turns are refused, and the reason is said on its latest turn */
  worktreeFailed: (threadId: string, reason: string) => Promise<void>;
  info: (threadId: string, kind: "info" | "error", text: string, id?: string) => Promise<void>;
  detach: (threadId: string) => Promise<boolean>;
  dispatch: (command: InternalCommand) => Promise<void>;
  onPrChange?: (threadId: string) => void;
  log: (msg: string, data?: unknown) => void;
}

export interface VcsRecoveryOptions {
  /** the persisted `thread.created` intent; the read model does not keep `useWorktree` / `baseRef` */
  threadCreated?: (threadId: string) => { useWorktree?: boolean; baseRef?: string } | undefined;
  journal?: IntentJournal;
  projectTimeoutMs?: number;
}

export interface VcsRecoveryReport {
  merges: { threadId: string; outcome: "merged" | "error" }[];
  adopted: string[];
  created: string[];
  warned: string[];
  pruned: string[];
  lostIntents: number;
  removedDirs: string[];
  /** checkpoint refs of deleted threads removed, summed over repositories */
  sweptRefs: number;
  keptDirs: string[];
  /** projects whose pass failed or timed out (logged; boot went on) */
  failedProjects: string[];
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Paths compared after symlinks are resolved (macOS temp dirs live behind /var -> /private/var). */
function canon(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function withTimeout<T>(task: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
}

/** Threads with at least one turn a harness started (a turn settled before it started never touched the checkout). */
function threadsThatRan(model: ReadModel): Set<string> {
  const ran = new Set<string>();
  for (const turn of Object.values(model.turns)) if (turn.startedAt !== undefined) ran.add(turn.threadId);
  return ran;
}

export async function recoverVcs(deps: VcsRecoveryDeps, options: VcsRecoveryOptions = {}): Promise<VcsRecoveryReport> {
  const report: VcsRecoveryReport = { merges: [], adopted: [], created: [], warned: [], pruned: [], lostIntents: 0, removedDirs: [], sweptRefs: 0, keptDirs: [], failedProjects: [] };
  const model = deps.engine.getModel();
  const timeoutMs = options.projectTimeoutMs ?? DEFAULT_PROJECT_TIMEOUT_MS;
  const ran = threadsThatRan(model);
  const registered = new Map<string, Set<string>>();
  // merge intents the dead process journaled, by thread: what inspectMerge needs to recognise a landed merge
  const mergeIntents = new Map<string, Intent>();
  for (const [, intent] of options.journal?.lost() ?? []) if (intent.kind === "merge") mergeIntents.set(intent.threadId, intent);

  const projects = Object.values(model.projects).filter((p) => p.archivedAt === undefined);
  await Promise.all(
    projects.map(async (project) => {
      try {
        const paths = await withTimeout(recoverProject(deps, options, project, ran, mergeIntents, report), timeoutMs, `recovery of ${project.rootPath}`);
        if (paths !== undefined) registered.set(project.id, paths);
      } catch (err) {
        report.failedProjects.push(project.id);
        deps.log(`[vcs-recovery] project ${project.rootPath} skipped: ${message(err)}`);
      }
    }),
  );
  // a merge in an archived project still blocks its thread: report it, without git
  for (const thread of Object.values(model.threads)) {
    const project = model.projects[thread.projectId];
    if (thread.merge?.status === "merging" && (project === undefined || project.archivedAt !== undefined)) {
      await deps.exclusive(thread.id, () => settleMerge(deps, thread.id, { outcome: "error", text: MERGE_RESTART_ERROR }, report));
    }
  }

  await recoverIntents(deps, options.journal, report);
  await sweepStrayWorktrees(deps, projects, registered, report);
  try {
    const lookup = options.threadCreated;
    const swept = await withTimeout(
      sweepOrphanCheckpointRefs({ git: deps.git, log: deps.log }, deps.engine.getModel(), lookup !== undefined ? { knownToLog: (id) => lookup(id) !== undefined } : {}),
      timeoutMs,
      "checkpoint ref sweep",
    );
    for (const n of swept.deleted.values()) report.sweptRefs += n;
  } catch (err) {
    deps.log("[vcs-recovery] checkpoint ref sweep failed", message(err));
  }

  const counts = [
    [report.merges.length, "interrupted merge(s) settled"],
    [report.adopted.length, "orphan worktree(s) adopted"],
    [report.created.length, "missing worktree(s) created"],
    [report.warned.length, "thread(s) warned they run in the main checkout"],
    [report.lostIntents, "lost publish/detach intent(s) reported"],
    [report.removedDirs.length, "stray worktree dir(s) removed"],
    [report.sweptRefs, "checkpoint ref(s) of deleted threads removed"],
  ] as const;
  const said = counts.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`);
  if (said.length > 0) deps.log(`[vcs-recovery] ${said.join("; ")}`);
  if (report.keptDirs.length > 0) deps.log("[vcs-recovery] worktree directories no thread references, left in place", report.keptDirs);
  return report;
}

/** Steps 1–3 for one project; resolves to the canonical paths its `git worktree list` registers. */
async function recoverProject(
  deps: VcsRecoveryDeps,
  options: VcsRecoveryOptions,
  project: Project,
  ran: Set<string>,
  mergeIntents: Map<string, Intent>,
  report: VcsRecoveryReport,
): Promise<Set<string> | undefined> {
  const threads = Object.values(deps.engine.getModel().threads).filter((t) => t.projectId === project.id);
  const root = deps.git(project.rootPath);
  const healthy = existsSync(project.rootPath) && (await root.isRepo());

  if (healthy) {
    try {
      await deps.worktrees.prune(project.rootPath);
      report.pruned.push(project.id);
    } catch (err) {
      deps.log(`[vcs-recovery] git worktree prune failed in ${project.rootPath}`, message(err));
    }
  } else {
    deps.log(`[vcs-recovery] ${project.rootPath} is not a reachable git repository; only stuck merges are settled`);
  }

  for (const thread of threads) {
    if (thread.merge?.status !== "merging") continue;
    await deps.exclusive(thread.id, async () => {
      const outcome = healthy ? await inspectMerge(deps, project, thread.id, mergeIntents.get(thread.id)) : { outcome: "error" as const, text: MERGE_RESTART_ERROR };
      await settleMerge(deps, thread.id, outcome, report);
    });
  }

  if (!healthy) return undefined;
  for (const thread of threads) {
    if (thread.archivedAt !== undefined || thread.worktreePath !== undefined || thread.branch !== undefined) continue;
    const intent = options.threadCreated?.(thread.id);
    if (intent?.useWorktree !== true) continue;
    await deps.exclusive(thread.id, () => recoverWorktree(deps, project, thread.id, intent.baseRef, ran.has(thread.id), report));
  }
  return new Set((await root.worktreeList()).map((w) => canon(w.path)));
}

type MergeVerdict = { outcome: "merged"; sha: string; text: string } | { outcome: "error"; text: string };

/**
 * What a dead merge left: (a) nothing, (b) a scratch worktree with a merge/rebase in progress
 * (removed like a failed merge), (c) a merge that landed before its report was lost. (c) is
 * recognised when the branch head is an ancestor of the base (merge strategy, a fast-forward
 * rebase, nothing to squash) or, for rebase, when every branch commit has a patch-identical
 * commit on the base (`git cherry`), and the worktree holds no uncommitted work (a merge commits
 * it first). The journaled merge intent adds two signals: the commit the base was moved to (written
 * the moment the merge returned, so it survives a crash during branch deletion or the report) and,
 * for a squash, the base head at the start, from which `findLandedSquash` recognises the squash
 * commit by its parent and tree. A squash without a journaled intent is reported as interrupted.
 */
async function inspectMerge(deps: VcsRecoveryDeps, project: Project, threadId: string, intent: Intent | undefined): Promise<MergeVerdict> {
  const thread = deps.engine.getModel().threads[threadId];
  if (thread?.merge?.status !== "merging") return { outcome: "error", text: MERGE_RESTART_ERROR };
  try {
    if (await deps.merge.dropLeftover(project.rootPath, threadId)) deps.log(`[vcs-recovery] removed the scratch merge worktree of ${threadId}`);
  } catch (err) {
    deps.log(`[vcs-recovery] scratch merge worktree of ${threadId} could not be removed`, message(err));
  }
  if (thread.pr?.state === "open") {
    // the PR watcher's next refresh records a merge GitHub completed
    deps.onPrChange?.(threadId);
    return { outcome: "error", text: `${MERGE_RESTART_ERROR} (pull request #${thread.pr.number}: check it on the forge)` };
  }
  const { baseBranch: base, branch: head } = thread;
  if (base === undefined || head === undefined) return { outcome: "error", text: MERGE_RESTART_ERROR };
  try {
    const root = deps.git(project.rootPath);
    const baseSha = await root.revParse(`refs/heads/${base}`);
    if (baseSha === undefined) return { outcome: "error", text: MERGE_RESTART_ERROR };
    const landed = `${base} already contains ${head}: the merge finished before the server restarted`;
    if (intent?.landed !== undefined && (await root.tryRun(["merge-base", "--is-ancestor", intent.landed, baseSha])).code === 0) {
      return { outcome: "merged", sha: intent.landed, text: landed };
    }
    const headSha = await root.revParse(`refs/heads/${head}`);
    if (headSha === undefined) return { outcome: "error", text: MERGE_RESTART_ERROR };
    // a merge commits the worktree's pending work first: uncommitted work means it never got that far
    if (thread.worktreePath !== undefined && existsSync(thread.worktreePath)) {
      const wt = deps.git(thread.worktreePath);
      if ((await wt.isRepo()) && (await wt.status()).dirty > 0) return { outcome: "error", text: MERGE_RESTART_ERROR };
    }
    if ((await root.tryRun(["merge-base", "--is-ancestor", headSha, baseSha])).code === 0) return { outcome: "merged", sha: baseSha, text: landed };
    if (thread.merge.strategy === "rebase") {
      const cherry = await root.tryRun(["cherry", baseSha, headSha]);
      const lines = cherry.stdout.split("\n").filter((l) => l.trim() !== "");
      if (cherry.code === 0 && lines.length > 0 && lines.every((l) => l.startsWith("-"))) return { outcome: "merged", sha: baseSha, text: landed };
    }
    if (thread.merge.strategy === "squash" && intent?.baseSha !== undefined) {
      const squash = await findLandedSquash(root, intent.baseSha, baseSha, headSha);
      if (squash !== undefined) return { outcome: "merged", sha: squash, text: `the squash of ${head} landed on ${base} before the server restarted` };
    } else if (thread.merge.strategy === "squash") {
      return { outcome: "error", text: `${MERGE_RESTART_ERROR} (a squash that landed cannot be detected: look for it on ${base} first)` };
    }
  } catch (err) {
    deps.log(`[vcs-recovery] could not inspect the merge of ${threadId}`, message(err));
  }
  return { outcome: "error", text: MERGE_RESTART_ERROR };
}

async function settleMerge(deps: VcsRecoveryDeps, threadId: string, verdict: MergeVerdict, report: VcsRecoveryReport): Promise<void> {
  if (deps.engine.getModel().threads[threadId]?.merge?.status !== "merging") return;
  if (verdict.outcome === "merged") {
    await deps.dispatch({ type: "merge.report", threadId, outcome: "merged", sha: verdict.sha });
    await deps.info(threadId, "info", `Merged: ${verdict.text}`);
  } else {
    await deps.dispatch({ type: "merge.report", threadId, outcome: "error", error: verdict.text });
    await deps.info(threadId, "error", `Merge ${verdict.text}`);
  }
  report.merges.push({ threadId, outcome: verdict.outcome });
}

async function recoverWorktree(
  deps: VcsRecoveryDeps,
  project: Project,
  threadId: string,
  baseRef: string | undefined,
  alreadyRan: boolean,
  report: VcsRecoveryReport,
): Promise<void> {
  const model = deps.engine.getModel();
  const thread = model.threads[threadId];
  if (!thread || thread.worktreePath !== undefined || thread.branch !== undefined) return;
  if (alreadyRan) {
    // its turns ran (and edited) in the main checkout: moving them now would be worse
    const id = `vcs-recovery-main-checkout-${threadId}`;
    const said = (model.threadTimeline[threadId] ?? []).some((e) => {
      const a = e.kind === "activity" ? model.activities[e.id] : undefined;
      return a !== undefined && (a.id === id || (a.kind === "error" && a.text.startsWith(WORKTREE_FAILURE_PREFIX)));
    });
    if (!said) {
      await deps.info(threadId, "error", MAIN_CHECKOUT_WARNING, id);
      report.warned.push(threadId);
    }
    return;
  }
  const expected = deps.worktrees.pathFor(project, thread);
  const root = deps.git(project.rootPath);
  const entry = (await root.worktreeList()).find((w) => canon(w.path) === canon(expected));
  if (entry !== undefined && entry.branch?.startsWith("tide/") === true && existsSync(expected) && (await deps.git(expected).isRepo())) {
    const baseBranch = (await root.currentBranch()) ?? (await root.revParse("HEAD")) ?? "HEAD";
    await deps.worktrees.provision(project, expected);
    await deps.dispatch({ type: "worktree.attach", threadId, worktreePath: expected, branch: entry.branch, baseBranch });
    report.adopted.push(threadId);
    return;
  }
  if (entry === undefined && existsSync(expected) && !(await removableDir(expected))) {
    deps.log(`[vcs-recovery] ${expected} exists but is not a worktree; left in place, thread ${threadId} gets no worktree and its turns are refused`);
    await deps.worktreeFailed(threadId, `${expected} exists and is not a worktree`);
    return;
  }
  if (entry === undefined && existsSync(expected)) await rm(expected, { recursive: true, force: true });
  const failure = await deps.createWorktree(threadId, baseRef);
  if (failure === undefined) report.created.push(threadId);
}

/** Only an empty directory, or one holding nothing but a dangling `.git` link file, is safe to delete. */
async function removableDir(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);
    return entries.length === 0 || (entries.length === 1 && entries[0] === ".git");
  } catch {
    return false;
  }
}

async function recoverIntents(deps: VcsRecoveryDeps, journal: IntentJournal | undefined, report: VcsRecoveryReport): Promise<void> {
  if (journal === undefined) return;
  for (const [key, intent] of journal.lost()) {
    const { threadId, kind } = intent;
    if (kind === "merge") {
      // settled from the model's `merging` status above; the intent only fed inspectMerge
      journal.end(key);
      continue;
    }
    try {
      await deps.exclusive(threadId, async () => {
        const thread = deps.engine.getModel().threads[threadId];
        if (!thread) return;
        if (kind === "publish") {
          await deps.info(threadId, "info", "A publish was interrupted by a server restart and may not have finished: check the branch and pull request, then publish again.");
          report.lostIntents++;
        } else if (kind === "detach" && thread.worktreePath !== undefined) {
          await deps.info(threadId, "info", `Removing the worktree was interrupted by a server restart; it is still at ${thread.worktreePath}. Remove it again if you still want it gone.`);
          report.lostIntents++;
        } else if (kind === "archive" && thread.archivedAt !== undefined && thread.worktreePath !== undefined) {
          // archiving is the user's settled wish and the detach path parks uncommitted work first
          await deps.detach(threadId);
          report.lostIntents++;
        }
      });
    } catch (err) {
      deps.log(`[vcs-recovery] lost ${kind} of ${threadId} not handled`, message(err));
    }
    journal.end(key);
  }
}

/**
 * Directories under `<TIDE_HOME>/worktrees/<projectSlug>/` no thread references. One is removed
 * only when no project's `git worktree list` registers it and it holds no files; everything
 * else is left for the user and logged. Projects whose pass failed are not swept.
 */
async function sweepStrayWorktrees(deps: VcsRecoveryDeps, projects: Project[], registered: Map<string, Set<string>>, report: VcsRecoveryReport): Promise<void> {
  const model = deps.engine.getModel();
  const allRegistered = new Set<string>();
  for (const paths of registered.values()) for (const p of paths) allRegistered.add(p);
  const referenced = new Set<string>();
  for (const thread of Object.values(model.threads)) {
    if (thread.worktreePath !== undefined) referenced.add(canon(thread.worktreePath));
    const project = model.projects[thread.projectId];
    if (project !== undefined && thread.archivedAt === undefined) referenced.add(canon(deps.worktrees.pathFor(project, thread)));
  }
  for (const project of projects) {
    if (!registered.has(project.id)) continue;
    const dir = deps.worktrees.projectDir(project);
    let names: string[];
    try {
      names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      const key = canon(path);
      if (referenced.has(key)) continue;
      if (!allRegistered.has(key) && (await removableDir(path))) {
        try {
          await rm(path, { recursive: true, force: true });
          report.removedDirs.push(path);
        } catch (err) {
          deps.log(`[vcs-recovery] could not remove ${path}`, message(err));
        }
      } else {
        report.keptDirs.push(path);
      }
    }
  }
}

/** Typed helper for `app.ts`: the thread's own `thread.created` payload, read through a lookup. */
export function createdIntent(payload: string | undefined): { useWorktree?: boolean; baseRef?: string } | undefined {
  if (payload === undefined) return undefined;
  try {
    const event = JSON.parse(payload) as { type?: string; useWorktree?: boolean; baseRef?: string };
    if (event.type !== "thread.created") return undefined;
    return { ...(event.useWorktree !== undefined ? { useWorktree: event.useWorktree } : {}), ...(event.baseRef !== undefined ? { baseRef: event.baseRef } : {}) };
  } catch {
    return undefined;
  }
}
