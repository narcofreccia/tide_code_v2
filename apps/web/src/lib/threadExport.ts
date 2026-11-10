import type { Activity, ActivityOf, ApprovalDecision, Message, ProposedPlan, ReadModel } from "@tide/contracts";
import { selectTimeline } from "@tide/client";
import { toolTarget } from "./activity.ts";
import { copyWithToast } from "./clipboard.ts";
import { useModel } from "../state/model.ts";
import { showToast } from "../state/toast.ts";

export interface ThreadExportOptions {
  /** append each tool call's (truncated) output as a fenced block under its line */
  includeToolOutput?: boolean;
}

const DECISIONS: Record<ApprovalDecision, string> = {
  accept: "allowed",
  acceptForSession: "allowed for the session",
  acceptAlways: "always allowed",
  decline: "declined",
  cancel: "cancelled",
};

/** `2026-11-10 14:03 UTC`: one zone, so an export reads the same wherever it is opened. */
export function exportDate(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** A fence longer than any backtick run inside `text`, so the block cannot close early. */
function fence(text: string, lang = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${lang}\n${text.replace(/\n$/, "")}\n${ticks}`;
}

/** Inline code that survives backticks in the value. */
function code(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.includes("`") ? `\`\` ${flat} \`\`` : `\`${flat}\``;
}

function answerText(value: unknown): string {
  if (Array.isArray(value)) return value.map(answerText).join(", ");
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "no answer";
  return JSON.stringify(value);
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? "" : `  ${line}`))
    .join("\n");
}

function activityLines(activity: Activity, options: ThreadExportOptions): string {
  switch (activity.kind) {
    case "tool": {
      const target = toolTarget(activity.input);
      const line = `- Tool: ${activity.toolName}${target === undefined ? "" : ` ${code(target)}`} (${activity.status})`;
      if (options.includeToolOutput !== true || activity.output === undefined || activity.output.trim() === "") return line;
      return `${line}\n\n${indent(fence(activity.output))}`;
    }
    case "approval":
      return approvalLine(activity);
    case "user-input":
      return questionLines(activity);
    case "child": {
      const about = activity.description === undefined ? "" : `: ${activity.description}`;
      return `- Sub-agent: ${activity.name}${about} (${activity.status})`;
    }
    case "info":
      return `- Note: ${activity.text}`;
    case "error":
      return `- Error: ${activity.text}`;
  }
}

function approvalLine(activity: ActivityOf<"approval">): string {
  const target = activity.title ?? toolTarget(activity.input);
  const what = `${activity.toolName}${target === undefined ? "" : ` ${code(target)}`}`;
  const decided = activity.decision === undefined ? (activity.status === "pending" ? "pending" : "resolved") : DECISIONS[activity.decision];
  return `- Approval: ${what} → ${decided}`;
}

function questionLines(activity: ActivityOf<"user-input">): string {
  const answers = activity.answers ?? {};
  if (activity.secret === true) {
    const decided = answers.decided === "provided" ? "provided" : answers.decided === "declined" ? "declined" : "pending";
    return `- Secret requested: ${activity.questions[0]?.text ?? ""} → ${decided}`;
  }
  return activity.questions
    .map((q) => {
      const answer = activity.status === "pending" ? "pending" : answerText(answers[q.id]);
      return `- Question: ${q.text} → ${answer}`;
    })
    .join("\n");
}

function planBlock(plan: ProposedPlan): string {
  return `#### Plan (${plan.status})\n\n${plan.markdown.trim()}`;
}

function messageHeading(message: Message, rolledBack: boolean): string {
  if (message.role === "assistant") return "### Assistant";
  if (message.notification !== undefined) return `### Tide (${message.notification.source})`;
  const tags = [message.steer === true ? "steer" : undefined, rolledBack ? "rolled back" : undefined].filter(Boolean);
  return tags.length === 0 ? "### You" : `### You (${tags.join(", ")})`;
}

/**
 * The thread as one Markdown document: a header (title, project, harness/model, created),
 * then the timeline in order. Tool calls are one line each; their output only with
 * `includeToolOutput`. Session boundaries are a rule plus "New session".
 */
export function threadToMarkdown(model: ReadModel, threadId: string, options: ThreadExportOptions = {}): string {
  const thread = model.threads[threadId];
  if (thread === undefined) return "";
  const project = model.projects[thread.projectId];
  const harness = [thread.providerId ?? thread.provider, thread.model].filter(Boolean).join(" · ");
  const out: string[] = [
    `# ${thread.title}`,
    [
      ...(project === undefined ? [] : [`- Project: ${project.title}`]),
      `- Harness: ${harness}`,
      ...(thread.branch === undefined ? [] : [`- Branch: ${code(thread.branch)}`]),
      `- Created: ${exportDate(thread.createdAt)}`,
    ].join("\n"),
  ];
  // consecutive list lines (tool, approval, question) form one list instead of one per paragraph
  let list: string[] = [];
  const flush = (): void => {
    if (list.length > 0) out.push(list.join("\n"));
    list = [];
  };
  // the assistant heading is written once per turn, however many tool calls split its text
  let headed: string | undefined;
  for (const item of selectTimeline(model, threadId)) {
    if (item.kind === "activity") {
      list.push(activityLines(item.activity, options));
      continue;
    }
    flush();
    if (item.kind === "boundary") {
      out.push("---", "*New session*");
      headed = undefined;
    } else if (item.kind === "plan") {
      out.push(planBlock(item.plan));
    } else {
      const message = item.message;
      const key = `${message.role}:${message.turnId}`;
      if (message.role === "user" || headed !== key) {
        out.push(messageHeading(message, model.turns[message.turnId]?.rolledBack === true));
        headed = key;
      }
      if (message.text.trim() !== "") out.push(message.text.trim());
    }
  }
  flush();
  return `${out.join("\n\n")}\n`;
}

/** `Fix the auth bug!` → `fix-the-auth-bug` (never empty). */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug === "" ? "thread" : slug;
}

/** `<slug>-<YYYY-MM-DD>.md` */
export function exportFileName(title: string, now: number = Date.now()): string {
  return `${slugify(title)}-${new Date(now).toISOString().slice(0, 10)}.md`;
}

/** Saves through a Blob + anchor `download`; false when the page cannot start a download. */
export function downloadText(fileName: string, text: string, type = "text/markdown"): boolean {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // the click has handed the blob to the download before this runs
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

/** ⋯ › Export as Markdown: downloads `<slug>-<date>.md`. */
export function exportThreadMarkdown(threadId: string, options: ThreadExportOptions = {}): void {
  const model = useModel.getState().model;
  const thread = model.threads[threadId];
  if (thread === undefined) return;
  const name = exportFileName(thread.title);
  const text = threadToMarkdown(model, threadId, options);
  if (downloadText(name, text)) showToast(`Exported ${name}`);
  else void copyWithToast(text, "Downloads are not available here; copied the thread as Markdown");
}

/** ⋯ › Copy as Markdown: the same document on the clipboard (works where downloads do not). */
export function copyThreadMarkdown(threadId: string, options: ThreadExportOptions = {}): void {
  const model = useModel.getState().model;
  if (model.threads[threadId] === undefined) return;
  void copyWithToast(threadToMarkdown(model, threadId, options), "Copied the thread as Markdown");
}
