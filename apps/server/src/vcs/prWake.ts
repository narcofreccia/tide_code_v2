import type { PrComment, PrDetail, PullRequest } from "@tide/contracts";
import type { CheckRun } from "./forge/types.ts";

export const LOG_LINES = 40;
const REVIEW_BODY_MAX = 1_500;
const COMMENT_BODY_MAX = 600;
const MAX_COMMENTS = 5;
const MAX_FAILED_NAMED = 3;
const LOG_MAX_CHARS = 6_000;

export interface PrWake {
  /** one line for the notice row */
  summary: string;
  /** the prompt the agent receives */
  text: string;
}

const clip = (s: string, max: number): string => {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};
const quote = (s: string): string => s.split("\n").map((l) => `> ${l}`).join("\n");

/** Check runs that are failing now and were not at the previous poll (by name). */
export function newlyFailed(previous: PullRequest, next: PullRequest): CheckRun[] {
  const failing = (next.checkRuns ?? []).filter((r) => r.status === "failure");
  if (failing.length === 0) return [];
  if (previous.checkRuns === undefined) return previous.checks === "failure" ? [] : failing;
  const before = new Set(previous.checkRuns.filter((r) => r.status === "failure").map((r) => r.name));
  const seen = new Set<string>();
  return failing.filter((r) => !before.has(r.name) && !seen.has(r.name) && seen.add(r.name));
}

/** CI went from failing to all green: worth a note, not a wake. */
export const checksRecovered = (previous: PullRequest, next: PullRequest): boolean => previous.checks === "failure" && next.checks === "success";

/**
 * Comments, reviews with a body and line comments the forge dated after the previous poll
 * (`previous.updatedAt` is when Tide last read the PR). Nothing on the first poll (the PR's
 * history is not news), and nothing the viewer wrote — the agent posts through the same account.
 */
export function newComments(previous: PullRequest, detail: PrDetail): PrComment[] {
  if (previous.comments === undefined) return [];
  return detail.comments.filter(
    (c) =>
      c.createdAt > previous.updatedAt &&
      c.author !== detail.viewer &&
      c.body.trim() !== "" &&
      // a changes-requested review is reported by its own section
      !(c.kind === "review" && c.reviewState === "changes_requested"),
  );
}

/**
 * What changed on a watched PR that the agent should act on, as one wake-up; undefined when
 * nothing did. `failedLog` holds the log tail of the first newly failed check when it could be read.
 */
export function prWake(previous: PullRequest, detail: PrDetail, failedLog?: string): PrWake | undefined {
  const next = detail.pr;
  const n = next.number;
  const parts: string[] = [];
  const sections: string[] = [];

  const failed = newlyFailed(previous, next);
  failed.slice(0, MAX_FAILED_NAMED).forEach((check, i) => {
    if (i === 0 && failedLog !== undefined && failedLog.trim() !== "") {
      const log = failedLog.length > LOG_MAX_CHARS ? failedLog.slice(-LOG_MAX_CHARS) : failedLog;
      sections.push(`CI \`${check.name}\` failed. Last lines of its log:\n\`\`\`\n${log.trimEnd()}\n\`\`\``);
    } else sections.push(`CI \`${check.name}\` failed: ${check.url ?? "no link reported"}`);
  });
  if (failed.length > MAX_FAILED_NAMED) sections.push(`…and ${failed.length - MAX_FAILED_NAMED} more failing checks (\`gh pr checks ${n}\`).`);
  if (failed.length === 1 && failed[0] !== undefined) parts.push(`CI \`${failed[0].name}\` failed`);
  else if (failed.length > 1) parts.push(`${failed.length} CI checks failed`);

  if (next.reviewDecision === "changes_requested" && previous.reviewDecision !== undefined && previous.reviewDecision !== "changes_requested") {
    const review = [...detail.comments].reverse().find((c) => c.kind === "review" && c.reviewState === "changes_requested");
    parts.push("changes requested");
    if (review === undefined) sections.push("A reviewer requested changes.");
    else sections.push(`Changes requested by @${review.author}${review.body.trim() === "" ? " (no summary; see the line comments)." : `:\n${quote(clip(review.body, REVIEW_BODY_MAX))}`}`);
  }

  const comments = newComments(previous, detail);
  if (comments.length > 0) {
    parts.push(`${comments.length} new comment${comments.length === 1 ? "" : "s"}`);
    const lines = comments.slice(0, MAX_COMMENTS).map((c) => {
      const where = c.path !== undefined ? ` on \`${c.path}${c.line !== undefined ? `:${c.line}` : ""}\`` : "";
      return `- @${c.author}${where}:\n${quote(clip(c.body, COMMENT_BODY_MAX))}`;
    });
    if (comments.length > MAX_COMMENTS) lines.push(`- …and ${comments.length - MAX_COMMENTS} more (\`gh pr view ${n} --comments\`).`);
    sections.push(`New comments:\n${lines.join("\n")}`);
  }

  if (next.mergeable === false && previous.mergeable !== false) {
    parts.push("conflicts with its base");
    sections.push(`The branch now conflicts with its base${next.base !== undefined ? ` (\`${next.base}\`)` : ""}.`);
  }

  if (sections.length === 0) return undefined;
  return {
    summary: `PR #${n}: ${parts.join(", ")}`,
    text: `Pull request #${n} changed.\n\n${sections.join("\n\n")}\n\nAddress what needs addressing (\`gh pr view ${n} --comments\` and \`gh pr checks ${n}\` have the rest).`,
  };
}
