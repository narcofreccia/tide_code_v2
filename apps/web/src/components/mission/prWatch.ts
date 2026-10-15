import type { Thread } from "@tide/contracts";

/** "👁 PR #12 · ✔ · 3 comments" for a watched thread; undefined when it is not watched. */
export function prWatchLabel(thread: Thread): string | undefined {
  if (thread.prWatch === undefined || thread.pr === undefined) return undefined;
  const { number, checks, comments } = thread.pr;
  const ci = checks === "success" ? "✔" : checks === "failure" ? "✘" : "…";
  const parts = [`👁 PR #${number}`, ci];
  if (comments !== undefined && comments > 0) parts.push(`${comments} comment${comments === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
