import { create } from "zustand";
import type { UserSettings } from "@tide/contracts";
import { useServerSettings } from "../state/serverSettings.ts";

export type FollowUpMode = UserSettings["followUpMode"];

interface FollowUpState {
  /** per-thread choice made with the composer toggle; lives for this session only */
  byThread: Record<string, FollowUpMode>;
  set: (threadId: string, mode: FollowUpMode) => void;
}

export const useFollowUpStore = create<FollowUpState>((set) => ({
  byThread: {},
  set: (threadId, mode) => set((s) => ({ byThread: { ...s.byThread, [threadId]: mode } })),
}));

/** Test seam: forgets every per-thread choice. */
export function resetFollowUp(): void {
  useFollowUpStore.setState({ byThread: {} });
}

export interface FollowUp {
  /** what the primary send button and `⌘↵` do while a turn runs */
  mode: FollowUpMode;
  /** what `⌥↵` does while a turn runs */
  alternate: FollowUpMode;
  canSteer: boolean;
  setMode: (mode: FollowUpMode) => void;
}

/**
 * The thread's own choice wins, then Settings › General (server-side). A harness
 * that cannot steer is pinned to queue regardless; the choice is kept for when
 * the thread moves to a harness that can.
 */
export function useFollowUp(threadId: string, canSteer: boolean): FollowUp {
  const chosen = useFollowUpStore((s) => s.byThread[threadId]);
  const setFor = useFollowUpStore((s) => s.set);
  const fallback = useServerSettings((s) => s.settings.followUpMode);
  const mode: FollowUpMode = canSteer ? (chosen ?? fallback) : "queue";
  const alternate: FollowUpMode = canSteer && mode === "queue" ? "steer" : "queue";
  return { mode, alternate, canSteer, setMode: (next) => setFor(threadId, next) };
}
