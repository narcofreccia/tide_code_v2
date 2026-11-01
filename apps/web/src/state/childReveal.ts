import { create } from "zustand";

/**
 * A request to bring one sub-agent's group into view in the transcript and open it
 * (from the background-agents strip or a "<name> reported" notice). `nonce` makes a
 * second click on the same agent a new request.
 */
interface ChildRevealState {
  target: { threadId: string; childKey: string; nonce: number } | null;
}

export const useChildReveal = create<ChildRevealState>(() => ({ target: null }));

let nonce = 0;

export function revealChild(threadId: string, childKey: string): void {
  nonce += 1;
  useChildReveal.setState({ target: { threadId, childKey, nonce } });
}

/** The pending request's nonce for this child, 0 when none: a number, safe as a store selector. */
export function useRevealNonce(threadId: string, childKey: string): number {
  return useChildReveal((s) => (s.target !== null && s.target.threadId === threadId && s.target.childKey === childKey ? s.target.nonce : 0));
}
