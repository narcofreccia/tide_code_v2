import type { PrComment, PrDetail, PullRequest } from "@tide/contracts";
import type { CheckRun } from "./types.ts";

/** Fields `gh pr list` / `gh pr view` are asked for; `pr.list` and PR watch read the same shape. */
export const PR_FIELDS = [
  "number", "title", "url", "state", "isDraft", "author", "baseRefName", "headRefName", "reviewDecision",
  "statusCheckRollup", "mergeable", "additions", "deletions", "changedFiles", "updatedAt", "mergedAt", "comments",
].join(",");
export const PR_DETAIL_FIELDS = `${PR_FIELDS},body,reviews,files`;

const FAILED = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const PASSED = new Set(["SUCCESS", "NEUTRAL"]);
const SKIPPED = new Set(["SKIPPED", "STALE"]);

type Raw = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const login = (v: unknown): string | undefined => str((v as Raw | null | undefined)?.login);
const time = (v: unknown): number | undefined => {
  const s = str(v);
  if (s === undefined) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
};
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : []);

/** One `statusCheckRollup` entry (a CheckRun or a commit StatusContext) as a check run. */
export function toCheckRun(item: Raw): CheckRun {
  const name = str(item.name) ?? str(item.context) ?? "check";
  const url = str(item.detailsUrl) ?? str(item.targetUrl);
  let status: CheckRun["status"];
  if (item.state !== undefined && item.status === undefined) {
    const state = String(item.state).toUpperCase();
    status = state === "SUCCESS" ? "success" : FAILED.has(state) ? "failure" : "pending";
  } else if (String(item.status ?? "").toUpperCase() !== "COMPLETED") {
    status = "pending";
  } else {
    const conclusion = String(item.conclusion ?? "").toUpperCase();
    status = FAILED.has(conclusion) ? "failure" : SKIPPED.has(conclusion) ? "skipped" : PASSED.has(conclusion) || conclusion === "" ? "success" : "pending";
  }
  return { name, status, ...(url !== undefined ? { url } : {}) };
}

/** CI rollup → one verdict: any failure wins, then anything unfinished, then success; none = undefined. */
export function rollupChecks(runs: CheckRun[]): PullRequest["checks"] {
  if (runs.length === 0) return undefined;
  if (runs.some((r) => r.status === "failure")) return "failure";
  return runs.some((r) => r.status === "pending") ? "pending" : "success";
}

function toState(raw: unknown): PullRequest["state"] {
  const s = String(raw ?? "").toUpperCase();
  return s === "MERGED" ? "merged" : s === "CLOSED" ? "closed" : "open";
}

function toReviewDecision(raw: unknown): NonNullable<PullRequest["reviewDecision"]> {
  switch (String(raw ?? "").toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    default:
      return "none";
  }
}

/** `owner/name` from a PR URL (`https://host/owner/name/pull/7`). */
export function repoOfUrl(url: string): string | undefined {
  const m = /^https?:\/\/[^/]+\/(.+)\/pull\/\d+\/?$/.exec(url);
  return m?.[1];
}

/** A `gh pr list` / `gh pr view` JSON object; `now` is the read time (`updatedAt`). */
export function toPullRequest(raw: Raw, now: number): PullRequest | undefined {
  const url = str(raw.url);
  const number = num(raw.number);
  if (url === undefined || number === undefined) return undefined;
  const runs = arr(raw.statusCheckRollup).map(toCheckRun);
  const checks = rollupChecks(runs);
  const mergeable = raw.mergeable === "MERGEABLE" ? true : raw.mergeable === "CONFLICTING" ? false : undefined;
  const opt = <K extends keyof PullRequest>(key: K, value: PullRequest[K] | undefined): Partial<PullRequest> => (value === undefined ? {} : { [key]: value });
  return {
    url,
    number,
    state: toState(raw.state),
    updatedAt: now,
    ...opt("checks", checks),
    ...opt("mergeable", mergeable),
    // conversation comments plus reviews (the list command does not fetch reviews)
    comments: arr(raw.comments).length + arr(raw.reviews).length,
    ...opt("title", str(raw.title)),
    ...opt("author", login(raw.author)),
    ...opt("base", str(raw.baseRefName)),
    ...opt("head", str(raw.headRefName)),
    ...opt("draft", typeof raw.isDraft === "boolean" ? raw.isDraft : undefined),
    reviewDecision: toReviewDecision(raw.reviewDecision),
    checkRuns: runs,
    ...opt("additions", num(raw.additions)),
    ...opt("deletions", num(raw.deletions)),
    ...opt("changedFiles", num(raw.changedFiles)),
    ...opt("mergedAt", time(raw.mergedAt)),
    ...opt("repo", repoOfUrl(url)),
  };
}

/**
 * `gh pr view --json …,body,reviews,files` plus `gh api repos/{o}/{r}/pulls/N/comments` (line
 * comments; `gh pr view` has no paths) → PrDetail, comments oldest first.
 */
export function toPrDetail(raw: Raw, reviewComments: Raw[], now: number, viewer?: string): PrDetail {
  const pr = toPullRequest(raw, now);
  if (pr === undefined) throw new Error("gh pr view returned no url/number");
  const comments: PrComment[] = [];
  for (const c of arr(raw.comments)) {
    comments.push({ id: String(c.id ?? ""), author: login(c.author) ?? "ghost", body: String(c.body ?? ""), createdAt: time(c.createdAt) ?? 0, kind: "comment" });
  }
  for (const r of arr(raw.reviews)) {
    const state = String(r.state ?? "").toLowerCase();
    if (state === "pending") continue; // the viewer's own unsubmitted draft
    comments.push({ id: String(r.id ?? ""), author: login(r.author) ?? "ghost", body: String(r.body ?? ""), createdAt: time(r.submittedAt) ?? 0, kind: "review", reviewState: state });
  }
  for (const c of reviewComments) {
    const line = num(c.line) ?? num(c.original_line);
    const path = str(c.path);
    comments.push({
      id: String(c.id ?? ""),
      author: login(c.user) ?? "ghost",
      body: String(c.body ?? ""),
      createdAt: time(c.created_at) ?? 0,
      kind: "review-comment",
      ...(path !== undefined ? { path } : {}),
      ...(line !== undefined ? { line } : {}),
    });
  }
  comments.sort((a, b) => a.createdAt - b.createdAt);
  const files = arr(raw.files).map((f) => {
    const status = str(f.changeType)?.toLowerCase();
    return { path: String(f.path ?? ""), additions: num(f.additions) ?? 0, deletions: num(f.deletions) ?? 0, ...(status !== undefined ? { status } : {}) };
  });
  const body = str(raw.body);
  return {
    pr,
    ...(body !== undefined ? { body } : {}),
    files,
    comments,
    ...(viewer !== undefined ? { viewer } : {}),
  };
}
