import type { PullRequest, ReadModel } from "@tide/contracts";

/** Where a PR stands on its way to merge; the PR tab's pill. */
export type PrReadinessLabel =
  | "ready"
  | "checks failing"
  | "changes requested"
  | "needs review"
  | "conflicts"
  | "draft"
  | "merged"
  | "closed";

export interface PrReadiness {
  /** 0..100, higher is closer to mergeable */
  score: number;
  label: PrReadinessLabel;
  /** plain-words reasons behind the label, most important first */
  reasons: string[];
}

export interface PrChecksSummary {
  passed: number;
  /** names of failing runs; `["checks"]` when only the rollup says failure */
  failed: string[];
  pending: number;
  /** the overall state: per-run when the forge listed runs, else the rollup */
  state: "success" | "failure" | "pending" | "none";
}

/** Check runs folded to counts; skipped runs count as neither passed nor failed. */
export function prChecksSummary(pr: PullRequest): PrChecksSummary {
  const runs = pr.checkRuns ?? [];
  if (runs.length > 0) {
    const failed = runs.filter((r) => r.status === "failure").map((r) => r.name);
    const pending = runs.filter((r) => r.status === "pending").length;
    const passed = runs.filter((r) => r.status === "success").length;
    const state = failed.length > 0 ? "failure" : pending > 0 ? "pending" : "success";
    return { passed, failed, pending, state };
  }
  switch (pr.checks) {
    case "failure":
      return { passed: 0, failed: ["checks"], pending: 0, state: "failure" };
    case "pending":
      return { passed: 0, failed: [], pending: 1, state: "pending" };
    case "success":
      return { passed: 0, failed: [], pending: 0, state: "success" };
    default:
      return { passed: 0, failed: [], pending: 0, state: "none" };
  }
}

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Readiness from the forge's facts only. Terminal states and drafts first, then the
 * hard blockers (conflicts, failing checks, requested changes), then review and CI
 * progress. Ties are broken by age in `sortByReadiness`, not here.
 */
export function prReadiness(pr: PullRequest): PrReadiness {
  if (pr.state === "merged") return { score: 0, label: "merged", reasons: ["merged"] };
  if (pr.state === "closed") return { score: 0, label: "closed", reasons: ["closed without merging"] };
  if (pr.draft === true) return { score: 10, label: "draft", reasons: ["still a draft"] };

  const checks = prChecksSummary(pr);
  const reasons: string[] = [];
  if (pr.mergeable === false) {
    return { score: 20, label: "conflicts", reasons: ["conflicts with the base branch"] };
  }
  if (checks.state === "failure") {
    reasons.push(`failing: ${checks.failed.join(", ")}`);
    if (pr.reviewDecision === "changes_requested") reasons.push("changes requested");
    return { score: 30, label: "checks failing", reasons };
  }
  if (pr.reviewDecision === "changes_requested") {
    reasons.push("a reviewer requested changes");
    if (checks.state === "pending") reasons.push("checks running");
    return { score: 40, label: "changes requested", reasons };
  }

  let score = 60;
  if (pr.reviewDecision === "approved") {
    score += 30;
    reasons.push("approved");
  } else if (pr.reviewDecision === "review_required") {
    reasons.push("waiting for a review");
  } else {
    score += 15;
  }
  if (checks.state === "success") {
    score += 10;
    reasons.push("checks passed");
  } else if (checks.state === "pending") {
    score -= 10;
    reasons.push("checks running");
  }
  const label: PrReadinessLabel = pr.reviewDecision === "review_required" ? "needs review" : "ready";
  return { score: clamp(score), label, reasons };
}

/**
 * Most ready first; on a tie the PR that has waited longer (older `updatedAt`)
 * leads, then the lower number. Returns a new array.
 */
export function sortByReadiness<T extends { pr: PullRequest }>(items: readonly T[]): T[] {
  const scored = items.map((item) => ({ item, score: prReadiness(item.pr).score }));
  scored.sort(
    (a, b) =>
      b.score - a.score || a.item.pr.updatedAt - b.item.pr.updatedAt || a.item.pr.number - b.item.pr.number,
  );
  return scored.map((s) => s.item);
}

/** Open PRs the read model knows about (thread-linked), one per URL; scoped to a project when given. */
export function selectOpenPrCount(model: ReadModel, projectId?: string): number {
  const urls = new Set<string>();
  for (const thread of Object.values(model.threads)) {
    if (thread.archivedAt !== undefined || !thread.pr || thread.pr.state !== "open") continue;
    if (projectId !== undefined && thread.projectId !== projectId) continue;
    urls.add(thread.pr.url);
  }
  return urls.size;
}
