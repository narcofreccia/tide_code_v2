import { useEffect } from "react";
import { create } from "zustand";
import type { SlashCommandInfo } from "@tide/contracts";
import { call } from "./model.ts";

/** A thread's list is re-asked after this long, or at once when its instance changes. */
export const COMMANDS_STALE_MS = 30_000;

interface Entry {
  /** the instance the list was fetched for */
  instanceId: string;
  commands: SlashCommandInfo[];
  fetchedAt: number;
  loading: boolean;
  /** the last ask failed: nothing is known, so nothing is flagged unknown */
  failed?: boolean;
}

interface SlashCommandsState {
  byThread: Record<string, Entry>;
}

export const useSlashCommandsStore = create<SlashCommandsState>(() => ({ byThread: {} }));

function put(threadId: string, entry: Entry): void {
  useSlashCommandsStore.setState((s) => ({ byThread: { ...s.byThread, [threadId]: entry } }));
}

/** `providers.commands` for a thread, at most once per instance per 30 s. */
export function loadSlashCommands(threadId: string, instanceId: string, now: number = Date.now()): void {
  const entry = useSlashCommandsStore.getState().byThread[threadId];
  const fresh = entry !== undefined && entry.instanceId === instanceId && (entry.loading || now - entry.fetchedAt < COMMANDS_STALE_MS);
  if (fresh) return;
  const keep = entry?.instanceId === instanceId ? entry.commands : [];
  put(threadId, { instanceId, commands: keep, fetchedAt: now, loading: true });
  call("providers.commands", { threadId })
    .then(({ commands }) => put(threadId, { instanceId, commands, fetchedAt: Date.now(), loading: false }))
    // no list is a pass-through, never an error: the text is sent as typed
    .catch(() => put(threadId, { instanceId, commands: keep, fetchedAt: Date.now(), loading: false, failed: true }));
}

export interface SlashCommands {
  commands: SlashCommandInfo[];
  /** an answer for this instance has arrived */
  loaded: boolean;
  loading: boolean;
}

const NONE: SlashCommandInfo[] = [];

/**
 * The thread's commands; fetched while `active` (the text starts with `/`) and the
 * harness lists commands at all. Stale entries for another instance read empty.
 */
export function useSlashCommands(threadId: string, instanceId: string, enabled: boolean, active: boolean): SlashCommands {
  const entry = useSlashCommandsStore((s) => s.byThread[threadId]);
  useEffect(() => {
    if (enabled && active) loadSlashCommands(threadId, instanceId);
  }, [enabled, active, threadId, instanceId]);
  if (!enabled || entry === undefined || entry.instanceId !== instanceId) return { commands: NONE, loaded: false, loading: enabled && active };
  return {
    commands: entry.commands,
    loaded: (!entry.loading && entry.failed !== true) || entry.commands.length > 0,
    loading: entry.loading,
  };
}

export function resetSlashCommands(): void {
  useSlashCommandsStore.setState({ byThread: {} });
}
