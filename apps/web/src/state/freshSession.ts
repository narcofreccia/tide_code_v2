import { create } from "zustand";

/** R17: threads whose next message opens a new native session (`/clear`, palette). Not persisted. */
interface FreshSessionState {
  armed: Record<string, true>;
  arm: (threadId: string) => void;
  disarm: (threadId: string) => void;
}

export const useFreshSession = create<FreshSessionState>((set) => ({
  armed: {},
  arm: (threadId) => set((s) => (s.armed[threadId] ? s : { armed: { ...s.armed, [threadId]: true } })),
  disarm: (threadId) =>
    set((s) => {
      if (!s.armed[threadId]) return s;
      const { [threadId]: _gone, ...rest } = s.armed;
      return { armed: rest };
    }),
}));

export const armFreshSession = (threadId: string): void => useFreshSession.getState().arm(threadId);
export const disarmFreshSession = (threadId: string): void => useFreshSession.getState().disarm(threadId);
export const isFreshSessionArmed = (threadId: string): boolean => useFreshSession.getState().armed[threadId] === true;

export function useArmed(threadId: string): boolean {
  return useFreshSession((s) => s.armed[threadId] === true);
}
