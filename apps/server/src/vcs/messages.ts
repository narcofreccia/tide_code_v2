import { completeOneShot, type OneShotDeps } from "../rpc/oneShot.ts";
import type { Git } from "./git.ts";

/**
 * R17 C5: commit subjects and PR text written by the user's `textModel` from the change itself.
 * Best effort by construction: any failure (no one-shot harness, timeout, empty answer, git
 * error) yields `undefined` and the caller keeps its `tide: <title>` fallback.
 */

export const MESSAGE_TIMEOUT_MS = 5_000;
/** the patch excerpt handed to the model */
export const PATCH_EXCERPT_BYTES = 4 * 1024;
const SUBJECT_MAX = 72;
const BODY_MAX = 4_000;

export const COMMIT_SYSTEM =
  "You write git commit messages. Answer with the message only: a subject line in the imperative mood of at most 72 characters, " +
  "optionally a blank line and a short body explaining why. No quotes, no code fences, no trailing period on the subject.";
export const PR_SYSTEM =
  "You write pull request descriptions. Answer with a title of at most 72 characters on the first line, a blank line, " +
  "then a concise Markdown body summarising what changed and why. No code fences around the whole answer.";

export interface MessageInput {
  /** repository the diff is read in */
  git: Git;
  threadTitle: string;
  kind: "commit" | "pr";
  /** `git diff` revision arguments, e.g. `["--cached"]` or `["main...HEAD"]` */
  range: string[];
}

export interface GeneratedMessage {
  subject: string;
  body?: string;
}

/** `--stat` plus the start of the patch; undefined when there is no change to describe. */
export async function diffExcerpt(git: Git, range: string[]): Promise<string | undefined> {
  const stat = await git.tryRun(["diff", "--stat", ...range]);
  if (stat.code !== 0 || stat.stdout.trim() === "") return undefined;
  const patch = await git.tryRun(["diff", "--no-color", "--no-ext-diff", ...range]);
  let excerpt = patch.code === 0 ? patch.stdout : "";
  if (Buffer.byteLength(excerpt, "utf8") > PATCH_EXCERPT_BYTES) {
    excerpt = `${Buffer.from(excerpt, "utf8").subarray(0, PATCH_EXCERPT_BYTES).toString("utf8")}\n… (patch truncated)`;
  }
  return `Changed files:\n${stat.stdout.trimEnd()}\n\nPatch (excerpt):\n${excerpt.trimEnd()}`;
}

/** Model output to `{ subject, body }`: quotes/fences/"Subject:" stripped, subject ≤ 72 chars. */
export function parseMessage(text: string): GeneratedMessage | undefined {
  const lines = text
    .replace(/^```[a-z]*\s*\n?|\n?```\s*$/g, "")
    .split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first < 0) return undefined;
  let subject = (lines[first] ?? "")
    .trim()
    .replace(/^(subject|title)\s*:\s*/i, "")
    .replace(/^#+\s*/, "")
    .replace(/^["'`*“‘]+|["'`*”’]+$/g, "")
    .replace(/[.\s]+$/, "");
  if (subject === "") return undefined;
  if (subject.length > SUBJECT_MAX) subject = `${subject.slice(0, SUBJECT_MAX - 1).trimEnd()}…`;
  const body = lines.slice(first + 1).join("\n").trim().replace(/^(body|description)\s*:\s*/i, "").slice(0, BODY_MAX).trim();
  return body === "" ? { subject } : { subject, body };
}

/** A harness that ignores its abort signal must not hold a merge or publish up. */
async function withDeadline<T>(work: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), MESSAGE_TIMEOUT_MS + 500);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function generateCommitMessage(deps: OneShotDeps, input: MessageInput): Promise<GeneratedMessage | undefined> {
  try {
    const excerpt = await diffExcerpt(input.git, input.range);
    if (excerpt === undefined) return undefined;
    const ask =
      input.kind === "commit"
        ? "Write the commit message for this change."
        : "Write the pull request title and description for this change.";
    const result = await withDeadline(completeOneShot(deps, {
      system: input.kind === "commit" ? COMMIT_SYSTEM : PR_SYSTEM,
      prompt: `${ask}\nThe work was done in a conversation titled "${input.threadTitle}".\n\n${excerpt}`,
      maxOutputTokens: input.kind === "commit" ? 300 : 800,
      timeoutMs: MESSAGE_TIMEOUT_MS,
      scratch: "messages",
    }));
    return result === undefined ? undefined : parseMessage(result.text);
  } catch {
    return undefined;
  }
}

/** `subject` + blank line + `body`, the shape `git commit -m` expects as one message. */
export function formatCommitMessage(message: GeneratedMessage): string {
  return message.body === undefined ? message.subject : `${message.subject}\n\n${message.body}`;
}
