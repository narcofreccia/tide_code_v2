import type { Thread } from "@tide/contracts";
import { plural } from "../../lib/format.ts";

/** "PR #12 · ✔ · 3 comments" for a watched thread (the row adds the eye icon); undefined when it is not watched. */
export function prWatchLabel(thread: Thread): string | undefined {
  if (thread.prWatch === undefined || thread.pr === undefined) return undefined;
  const { number, checks, comments } = thread.pr;
  const ci = checks === "success" ? "✔" : checks === "failure" ? "✘" : "…";
  const parts = [`PR #${number}`, ci];
  if (comments !== undefined && comments > 0) parts.push(plural(comments, "comment"));
  return parts.join(" · ");
}
