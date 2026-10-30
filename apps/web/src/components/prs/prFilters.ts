import { prChecksSummary, prReadiness, sortByReadiness, type PrReadinessLabel } from "@tide/client";
import type { PullRequest } from "@tide/contracts";
import type { PillTone } from "../ui/Pill.tsx";
import type { PrEntry } from "./prData.ts";

export type PrSort = "readiness" | "updated";

export interface PrFilter {
  /** null: all projects */
  projectId: string | null;
  scope: "open" | "all";
  mine: boolean;
  sort: PrSort;
}

/** The forge user an entry's environment answered with ("" key for the single-server case). */
export function viewerFor(entry: PrEntry, viewers: Record<string, string>): string | undefined {
  return viewers[entry.envId ?? ""];
}

export function filterPrs(items: readonly PrEntry[], filter: PrFilter, viewers: Record<string, string>): PrEntry[] {
  const kept = items.filter((item) => {
    if (filter.projectId !== null && item.projectId !== filter.projectId) return false;
    if (filter.scope === "open" && item.pr.state !== "open") return false;
    if (filter.mine) {
      const viewer = viewerFor(item, viewers);
      if (viewer === undefined || item.pr.author !== viewer) return false;
    }
    return true;
  });
  if (filter.sort === "readiness") return sortByReadiness(kept);
  return [...kept].sort((a, b) => b.pr.updatedAt - a.pr.updatedAt || b.pr.number - a.pr.number);
}

export const READINESS_TONE: Record<PrReadinessLabel, PillTone> = {
  ready: "ok",
  "checks failing": "error",
  "changes requested": "needs",
  "needs review": "running",
  conflicts: "error",
  draft: "muted",
  merged: "accent",
  closed: "idle",
};

/** `✔ 3 · ✘ lint, e2e · 1 running`; empty when the forge reported nothing. */
export function checksText(pr: PullRequest): string {
  const c = prChecksSummary(pr);
  const parts: string[] = [];
  if (c.passed > 0) parts.push(`✔ ${c.passed}`);
  else if (c.state === "success") parts.push("✔ checks");
  if (c.failed.length > 0) parts.push(`✘ ${c.failed.join(", ")}`);
  if (c.pending > 0) parts.push(c.passed === 0 && c.failed.length === 0 && pr.checkRuns === undefined ? "checks running" : `${c.pending} running`);
  return parts.join(" · ");
}

export function reviewText(pr: PullRequest): string {
  switch (pr.reviewDecision) {
    case "approved":
      return "approved";
    case "changes_requested":
      return "changes requested";
    case "review_required":
      return "review required";
    default:
      return "";
  }
}

/** Why Merge is off, or undefined when it can go. `anyway` lifts the soft blocks (failing checks, conflicts unknown). */
export function mergeBlock(pr: PullRequest, anyway: boolean): string | undefined {
  if (pr.state !== "open") return `already ${pr.state}`;
  if (pr.draft === true) return "still a draft";
  if (pr.mergeable === false) return "conflicts with the base branch";
  if (!anyway && prChecksSummary(pr).state === "failure") return "checks are failing";
  if (!anyway && pr.reviewDecision === "changes_requested") return "a reviewer requested changes";
  return undefined;
}

export { prReadiness };
