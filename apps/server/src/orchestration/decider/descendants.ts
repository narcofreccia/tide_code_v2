import type { ReadModel, Thread } from "@tide/contracts";

/**
 * Every thread that descends from `threadId` (children, delegates, forks; archived or not),
 * deepest first: a thread always comes before its parent, so deleting in this order never
 * leaves dangling lineage. A cycle in the lineage (never written by the decider, but the model
 * is data) is cut at the first repeat; the root itself is never returned.
 */
export function descendantsOf(model: ReadModel, threadId: string): Thread[] {
  const threads = Object.values(model.threads);
  const seen = new Set<string>([threadId]);
  const out: Thread[] = [];
  const visit = (id: string): void => {
    for (const child of threads) {
      if (seen.has(child.id) || (child.parentThreadId !== id && child.delegatedBy !== id)) continue;
      seen.add(child.id);
      visit(child.id);
      out.push(child);
    }
  };
  visit(threadId);
  return out;
}
