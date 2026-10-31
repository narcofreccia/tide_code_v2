import { useEffect } from "react";
import { create } from "zustand";
import { newId, type RunPlan, type RunRepo, type RunSession, type RunSessionChunk, type RunStack } from "@tide/contracts";
import { errorText } from "../lib/dispatchOrToast.ts";
import { call, dispatch, stream, useModel, type StreamControl } from "./model.ts";
import { onReconnect } from "./reconnect.ts";
import { ensureOwnerPtys, runOwnerId, setActivePty, setDrawerOpen } from "./terminals.ts";
import { showToast } from "./toast.ts";

// R13: a project's run stack on the client — profiles (per repo, from the server), the live
// session (`run.subscribe`), the last plan, and a pending selection while a toggle debounces.

export interface ProfilesEntry {
  repos: RunRepo[];
  loading: boolean;
  loaded: boolean;
  error?: string;
  /** the server predates `run.*` (method-not-found): the panel shows a quiet note instead */
  unsupported?: boolean;
}

interface RunState {
  profiles: Record<string, ProfilesEntry>;
  sessions: Record<string, RunSession | undefined>;
  plans: Record<string, RunPlan | undefined>;
  /** projectId → selection shown while its `project.runStack.set` is debounced / in flight */
  pending: Record<string, string[] | undefined>;
}

const EMPTY: RunState = { profiles: {}, sessions: {}, plans: {}, pending: {} };

export const useRun = create<RunState>(() => ({ ...EMPTY }));

const NO_REPOS: RunRepo[] = [];

/** Pure: one `run.subscribe` chunk applied to the snapshot. */
export function applyRunChunk(session: RunSession | undefined, chunk: RunSessionChunk, projectId: string): RunSession | undefined {
  if (chunk.kind === "snapshot") return chunk.session;
  if (chunk.kind === "ended") return undefined;
  const base: RunSession = session ?? { projectId, startedAt: chunk.status.since, services: {} };
  return { ...base, services: { ...base.services, [chunk.key]: chunk.status } };
}

function patchProfiles(projectId: string, patch: Partial<ProfilesEntry>): void {
  useRun.setState((s) => {
    const prev = s.profiles[projectId] ?? { repos: [], loading: false, loaded: false };
    return { profiles: { ...s.profiles, [projectId]: { ...prev, ...patch } } };
  });
}

function setSession(projectId: string, session: RunSession | undefined): void {
  useRun.setState((s) => ({ sessions: { ...s.sessions, [projectId]: session } }));
}

// ---- profiles ----

/** An older tide-server answers `run.*` with `method-not-found` ("unknown method run.…"). */
export function isMethodNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "method-not-found") return true;
  return error instanceof Error && error.message.startsWith("unknown method ");
}

/** `run.profiles.get`, once per project unless `force`. */
export async function loadProfiles(projectId: string, force = false): Promise<void> {
  const entry = useRun.getState().profiles[projectId];
  if (!force && entry && (entry.loaded || entry.loading)) return;
  patchProfiles(projectId, { loading: true });
  try {
    const { repos } = await call("run.profiles.get", { projectId });
    useRun.setState((s) => ({
      profiles: { ...s.profiles, [projectId]: { repos, loading: false, loaded: true } },
    }));
  } catch (error) {
    if (isMethodNotFound(error)) patchProfiles(projectId, { loading: false, loaded: true, unsupported: true });
    else patchProfiles(projectId, { loading: false, loaded: true, error: errorText(error) });
  }
}

/** Rescans one repo (manifests; the text model when `useModel`) and swaps it into the list. */
export async function rescanRepo(projectId: string, repoId: string, useModelScan = false): Promise<RunRepo | undefined> {
  try {
    const repo = await call("run.profiles.scan", { projectId, repoId, ...(useModelScan ? { useModel: true } : {}) });
    useRun.setState((s) => {
      const prev = s.profiles[projectId] ?? { repos: [], loading: false, loaded: true };
      const known = prev.repos.some((r) => r.repoId === repoId);
      const repos = known ? prev.repos.map((r) => (r.repoId === repoId ? repo : r)) : [...prev.repos, repo];
      return { profiles: { ...s.profiles, [projectId]: { ...prev, repos } } };
    });
    return repo;
  } catch (error) {
    showToast(`Scan failed: ${errorText(error)}`);
    return undefined;
  }
}

export interface RunProfilesView {
  repos: RunRepo[];
  loading: boolean;
  loaded: boolean;
  error: string | undefined;
  unsupported: boolean;
  refresh: () => void;
  rescan: (repoId: string, useModel?: boolean) => Promise<RunRepo | undefined>;
}

export function useRunProfiles(projectId: string | undefined): RunProfilesView {
  const entry = useRun((s) => (projectId === undefined ? undefined : s.profiles[projectId]));
  useEffect(() => {
    if (projectId !== undefined) void loadProfiles(projectId);
  }, [projectId]);
  return {
    repos: entry?.repos ?? NO_REPOS,
    loading: entry?.loading ?? projectId !== undefined,
    loaded: entry?.loaded ?? false,
    error: entry?.error,
    unsupported: entry?.unsupported ?? false,
    refresh: () => {
      if (projectId !== undefined) void loadProfiles(projectId, true);
    },
    rescan: (repoId, useModelScan = false) =>
      projectId === undefined ? Promise.resolve(undefined) : rescanRepo(projectId, repoId, useModelScan),
  };
}

// ---- session (ref-counted `run.subscribe` per project) ----

const subscriptions = new Map<string, { count: number; control: StreamControl }>();

function openStream(projectId: string): StreamControl {
  const control = stream("run.subscribe", { projectId }, (chunk) => {
    setSession(projectId, applyRunChunk(useRun.getState().sessions[projectId], chunk, projectId));
  });
  control.done.catch(() => undefined);
  return control;
}

/** Keeps the project's session live while retained; the last release cancels the stream. */
export function retainRunSession(projectId: string): () => void {
  const sub = subscriptions.get(projectId);
  if (sub) sub.count += 1;
  else subscriptions.set(projectId, { count: 1, control: openStream(projectId) });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = subscriptions.get(projectId);
    if (!current) return;
    current.count -= 1;
    if (current.count > 0) return;
    current.control.cancel();
    subscriptions.delete(projectId);
  };
}

/** The live session; `session.worktree` says which checkout of the root repo it runs from (absent = main checkout). */
export function useRunSession(projectId: string | undefined): RunSession | undefined {
  useEffect(() => (projectId === undefined ? undefined : retainRunSession(projectId)), [projectId]);
  return useRun((s) => (projectId === undefined ? undefined : s.sessions[projectId]));
}

// the stream dies with the socket; the server sends a fresh snapshot on resubscribe
onReconnect((envId) => {
  for (const [projectId, sub] of subscriptions) {
    if (envId !== undefined && useModel.getState().ownership.projects[projectId] !== envId) continue;
    sub.control.cancel();
    sub.control = openStream(projectId);
  }
});

// ---- actions ----

export interface StackOptions {
  /** run the project's own repo from this thread's worktree */
  threadId?: string;
  selected?: string[];
  pins?: Record<string, number>;
}

function stackParams(projectId: string, opts: StackOptions): { projectId: string; threadId?: string; selected?: string[]; pins?: Record<string, number> } {
  return {
    projectId,
    ...(opts.threadId === undefined ? {} : { threadId: opts.threadId }),
    ...(opts.selected === undefined ? {} : { selected: opts.selected }),
    ...(opts.pins === undefined ? {} : { pins: opts.pins }),
  };
}

/** Dry run; remembered as the project's last plan (rows it blocked show why). */
export async function planStack(projectId: string, opts: StackOptions = {}): Promise<RunPlan | undefined> {
  try {
    const plan = await call("run.plan", stackParams(projectId, opts));
    useRun.setState((s) => ({ plans: { ...s.plans, [projectId]: plan } }));
    return plan;
  } catch (error) {
    showToast(`Plan failed: ${errorText(error)}`);
    return undefined;
  }
}

export async function startStack(projectId: string, opts: StackOptions = {}): Promise<RunSession | undefined> {
  try {
    const session = await call("run.start", stackParams(projectId, opts));
    setSession(projectId, session);
    if (session.plan) {
      const plan = session.plan;
      useRun.setState((s) => ({ plans: { ...s.plans, [projectId]: plan } }));
    }
    return session;
  } catch (error) {
    showToast(`Start failed: ${errorText(error)}`);
    return undefined;
  }
}

export async function stopStack(projectId: string, key?: string): Promise<void> {
  try {
    await call("run.stop", { projectId, ...(key === undefined ? {} : { key }) });
  } catch (error) {
    showToast(`Stop failed: ${errorText(error)}`);
  }
}

export async function restartService(projectId: string, key: string): Promise<void> {
  try {
    setSession(projectId, await call("run.restart", { projectId, key }));
  } catch (error) {
    showToast(`Restart failed: ${errorText(error)}`);
  }
}

export async function setRunStack(projectId: string, runStack: RunStack): Promise<void> {
  try {
    await dispatch({ type: "project.runStack.set", commandId: newId(), projectId, runStack });
  } catch (error) {
    showToast(`Saving the stack failed: ${errorText(error)}`);
  }
}

export const SELECTION_DEBOUNCE_MS = 400;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Shows `selected` at once; saves it as the project's stack after a short pause (keeps its pins). */
export function setSelectionDebounced(projectId: string, selected: string[]): void {
  useRun.setState((s) => ({ pending: { ...s.pending, [projectId]: selected } }));
  const prev = timers.get(projectId);
  if (prev !== undefined) clearTimeout(prev);
  timers.set(
    projectId,
    setTimeout(() => {
      timers.delete(projectId);
      const pins = useModel.getState().model.projects[projectId]?.runStack?.pins ?? {};
      void setRunStack(projectId, { selected, pins }).finally(() => {
        if (useRun.getState().pending[projectId] !== selected) return;
        useRun.setState((s) => ({ pending: { ...s.pending, [projectId]: undefined } }));
      });
    }, SELECTION_DEBOUNCE_MS),
  );
}

/**
 * "Logs": opens the terminal drawer on the service's pty (by `ptyId` from the session, else the
 * tab labelled with the service name under `run:<projectId>`).
 */
export async function showServiceLog(threadId: string, projectId: string, name: string, ptyId?: string): Promise<boolean> {
  setDrawerOpen(true);
  const tabs = await ensureOwnerPtys(runOwnerId(projectId), true);
  const tab = tabs.find((t) => ptyId !== undefined && t.ptyId === ptyId) ?? tabs.find((t) => t.label === name);
  if (!tab) {
    showToast(`No terminal for ${name} yet`);
    return false;
  }
  setActivePty(threadId, tab.ptyId);
  return true;
}

export function resetRun(): void {
  for (const sub of subscriptions.values()) sub.control.cancel();
  subscriptions.clear();
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  useRun.setState({ ...EMPTY });
}
