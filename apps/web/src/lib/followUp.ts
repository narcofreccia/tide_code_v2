import { create } from "zustand";

export type FollowUpMode = "steer" | "queue";

export const FOLLOW_UP_KEY = "tide.followUpMode";

function readStored(): FollowUpMode | undefined {
  try {
    const value = window.localStorage.getItem(FOLLOW_UP_KEY);
    return value === "steer" || value === "queue" ? value : undefined;
  } catch {
    return undefined;
  }
}

interface FollowUpState {
  /** the user's saved default; undefined until they pick one */
  stored: FollowUpMode | undefined;
  set: (mode: FollowUpMode) => void;
}

export const useFollowUpStore = create<FollowUpState>((set) => ({
  stored: readStored(),
  set: (mode) => {
    try {
      window.localStorage.setItem(FOLLOW_UP_KEY, mode);
    } catch {
      /* private window: the choice lasts for this session only */
    }
    set({ stored: mode });
  },
}));

/** Test seam: re-reads localStorage (tests clear it between cases). */
export function resetFollowUp(): void {
  useFollowUpStore.setState({ stored: readStored() });
}

export interface FollowUp {
  /** what the primary send button does while a turn runs */
  mode: FollowUpMode;
  /** what `⌘↵` does while a turn runs */
  alternate: FollowUpMode;
  canSteer: boolean;
  setMode: (mode: FollowUpMode) => void;
}

/**
 * Steer is the default when the harness can; a harness that cannot steer is
 * pinned to queue regardless of the saved choice (which is kept for the next
 * harness that can).
 */
export function useFollowUp(canSteer: boolean): FollowUp {
  const stored = useFollowUpStore((s) => s.stored);
  const setMode = useFollowUpStore((s) => s.set);
  const mode: FollowUpMode = canSteer ? (stored ?? "steer") : "queue";
  const alternate: FollowUpMode = canSteer && mode === "queue" ? "steer" : "queue";
  return { mode, alternate, canSteer, setMode };
}
