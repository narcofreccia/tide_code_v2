import { newId, type MergeStrategy, type PrComment, type Thread } from "@tide/contracts";
import { call, dispatch } from "../../state/model.ts";
import { showToast } from "../../state/toast.ts";
import { errorText } from "../../lib/dispatchOrToast.ts";

/** Comments worth handing to an agent: anything with a body (review summaries, inline notes, conversation). */
export function reviewComments(comments: readonly PrComment[]): PrComment[] {
  return comments.filter((c) => c.body.trim() !== "" && c.reviewState !== "approved" && c.reviewState !== "dismissed");
}

function quote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** The prompt that asks a thread to address a PR's review comments, each quoted with where it points. */
export function addressCommentsPrompt(number: number, comments: readonly PrComment[]): string {
  const blocks = reviewComments(comments).map((c) => {
    const where = c.path === undefined ? "" : ` on \`${c.path}${c.line === undefined ? "" : `:${c.line}`}\``;
    const state = c.kind === "review" && c.reviewState ? ` (review: ${c.reviewState.replaceAll("_", " ")})` : "";
    return `**${c.author}**${where}${state}:\n${quote(c.body)}`;
  });
  return [
    `Address the review comments on PR #${number}.`,
    "",
    ...blocks.flatMap((b) => [b, ""]),
    "Make the changes on this branch, push them, and say what you did for each comment.",
  ].join("\n");
}

/** Sends the comments to the thread as a turn marked as a PR notice. */
export async function askThreadToAddress(threadId: string, number: number, comments: readonly PrComment[]): Promise<void> {
  if (reviewComments(comments).length === 0) {
    showToast(`PR #${number} has no review comments to address`);
    return;
  }
  await dispatch({
    type: "turn.request",
    threadId,
    text: addressCommentsPrompt(number, comments),
    requestId: newId(),
    notification: { source: "pr", summary: `Address review comments on #${number}` },
  });
  showToast(`Asked the thread to address the comments on #${number}`);
}

/** Thread header: fetches the PR's comments, then asks the thread. Failures become a toast. */
export async function addressThreadPrComments(thread: Thread): Promise<void> {
  const pr = thread.pr;
  if (!pr) return;
  try {
    const detail = await call("pr.detail", { projectId: thread.projectId, number: pr.number });
    await askThreadToAddress(thread.id, pr.number, detail.comments);
  } catch (error) {
    showToast(`Addressing review comments failed: ${errorText(error)}`);
  }
}

/** `pr.link`: the server resolves the number or URL on the forge. Resolves with the PR number. */
export async function linkPr(threadId: string, pr: string): Promise<number> {
  const out = await call("pr.link", { threadId, pr: pr.trim() });
  showToast(`Linked PR #${out.pr.number}`);
  return out.pr.number;
}

export interface PrTarget {
  projectId: string;
  number: number;
  envId?: string;
}

const routed = (t: PrTarget): { envId: string } | undefined => (t.envId === undefined ? undefined : { envId: t.envId });

export async function commentOnPr(t: PrTarget, body: string): Promise<void> {
  const opts = routed(t);
  const params = { projectId: t.projectId, number: t.number, body };
  await (opts ? call("pr.comment", params, opts) : call("pr.comment", params));
}

export type ReviewEvent = "approve" | "request_changes" | "comment";

export async function reviewPr(t: PrTarget, event: ReviewEvent, body?: string): Promise<void> {
  const opts = routed(t);
  const params = { projectId: t.projectId, number: t.number, event, ...(body ? { body } : {}) };
  await (opts ? call("pr.review", params, opts) : call("pr.review", params));
}

export async function mergePr(t: PrTarget, method: MergeStrategy, deleteBranch: boolean): Promise<{ merged: boolean; error?: string }> {
  const opts = routed(t);
  const params = { projectId: t.projectId, number: t.number, method, deleteBranch };
  return opts ? call("pr.merge", params, opts) : call("pr.merge", params);
}
