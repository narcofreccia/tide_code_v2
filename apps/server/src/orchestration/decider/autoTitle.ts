import type { EventOf, Thread } from "@tide/contracts";

/** The title `thread.create` gives a thread the user did not name. */
export const DEFAULT_THREAD_TITLE = "New thread";
const MAX_TITLE = 60;

/** Only the generic default is ever replaced: a typed title, a fork's, a plan's or a delegate's stays. */
export function hasDefaultTitle(thread: Pick<Thread, "title">): boolean {
  return thread.title.trim() === "" || thread.title === DEFAULT_THREAD_TITLE;
}

/**
 * A title from the first prompt: the first line with text once markdown markers (`#`, `*`,
 * backticks, a leading `>`/`-` bullet) are gone, whitespace collapsed, cut at 60 characters on
 * a word boundary with "…". Undefined when the prompt has no text (an image-only turn).
 */
export function titleFromPrompt(prompt: string): string | undefined {
  for (const raw of prompt.split("\n")) {
    const line = raw
      .replace(/[#*`]/g, "")
      .replace(/^\s*(?:[>-]\s*)+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line === "") continue;
    if (line.length <= MAX_TITLE) return line;
    const cut = line.slice(0, MAX_TITLE);
    const space = cut.lastIndexOf(" ");
    // one giant word (a URL, a path) is cut mid-word rather than reduced to nothing
    const head = space >= MAX_TITLE / 3 ? cut.slice(0, space) : cut;
    return `${head.replace(/[\s,.;:–—-]+$/, "")}…`;
  }
  return undefined;
}

/** The `thread.updated` that names a default-titled thread after `prompt`, if it should. */
export function autoTitleEvent(thread: Thread, prompt: string, at: number): EventOf<"thread.updated"> | undefined {
  if (!hasDefaultTitle(thread)) return undefined;
  const title = titleFromPrompt(prompt);
  if (title === undefined) return undefined;
  return { type: "thread.updated", threadId: thread.id, patch: { title }, autoTitled: true, updatedAt: at };
}
