// Plain JSON Schema tool definitions — no zod, no TypeBox, so this package stays a thin
// bridge. Descriptions say *when* to reach for the tool, because that is what the model
// actually reads.

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

const str = (description: string): Record<string, unknown> => ({ type: "string", description });

export const BASE_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "tide_experts_post_finding",
    description:
      "Post one substantive finding to the expert panel's shared board. Use it as soon as you learn something the panel should know — keep it short and concrete and cite file paths. Post several small findings rather than one long report.",
    inputSchema: {
      type: "object",
      properties: { text: str("The finding: one or two sentences, concrete, with paths.") },
      required: ["text"],
    },
  },
  {
    name: "tide_experts_read_findings",
    description: "Read every finding the panel has posted so far, including your own. Use it before you start discussing so you do not repeat a colleague.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "tide_experts_send_message",
    description:
      'Send a message to one colleague on the panel (their expert key), to the lead ("lead"), or to everyone ("all"). Use it to challenge a finding, ask a question, or hand over an area you will not cover.',
    inputSchema: {
      type: "object",
      properties: {
        to: str('Recipient: an expert key, "lead", or "all".'),
        text: str("The message."),
      },
      required: ["to", "text"],
    },
  },
  {
    name: "tide_experts_check_messages",
    description: "Read messages addressed to you (or to everyone) since the last check. Call it periodically while you work, and always before you conclude.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "tide_experts_synthesize",
    description:
      "Panel lead only: submit the final decision document. Call it once, with the complete markdown — the decision, the reasoning, the trade-offs and the recommended implementation steps. Do not implement anything yourself.",
    inputSchema: {
      type: "object",
      properties: { markdown: str("The full decision document, in markdown.") },
      required: ["markdown"],
    },
  },
  {
    name: "tide_delegate",
    description:
      "Hand a self-contained task to another coding harness as a new Tide thread, and get back its threadId. Use it for work that is worth running in parallel or that another harness is better at. Only claude, codex and opencode can be delegated to — pi has no Tide bridge and would never report back. Pass `role` to label what the thread is for (review, research, implementation). Pass `repo` with the label of one of this project's writable linked repositories to run the delegate inside that repository instead. By default it returns immediately (completion \"async\"): poll tide_delegate_status or call tide_thread_wait. With completion \"wait\" it blocks until the child settles and returns its last message; on timeout the child keeps running.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["claude", "codex", "opencode", "pi"], description: "Which harness runs the task." },
        prompt: str("The complete task description; the new thread has none of your context."),
        model: str("Optional model id for that harness."),
        mode: {
          type: "string",
          enum: ["approval-required", "auto-accept-edits", "auto", "full-access"],
          description: "Permission mode for the new thread. Defaults to your own mode, and is never allowed to exceed it.",
        },
        title: str("Optional short title for the new thread."),
        useWorktree: { type: "boolean", description: "Run the task in its own git worktree." },
        role: str("Free-text label for the child's job, at most 40 characters (e.g. review, research)."),
        completion: { type: "string", enum: ["async", "wait"], description: 'async (default): return the threadId at once. wait: block until the child settles and return its result. (Named completion because `mode` is the permission mode.)' },
        timeoutMs: { type: "number", description: "With completion=wait: how long to wait, 1000-600000, default 600000. A timeout never cancels the child." },
        clientRequestId: str("Idempotency key: repeating the call with the same id does not create a second thread."),
        repo: str("Label of a writable linked repository to run the delegate in; it becomes that thread's main repo. Read-only links are refused. Omit to use this project's repo."),
      },
      required: ["provider", "prompt"],
    },
  },
  {
    name: "tide_delegate_status",
    description: "Check a thread you delegated: whether it has settled, and its last assistant message. Poll this until `settled` is true.",
    inputSchema: {
      type: "object",
      properties: { threadId: str("The threadId returned by tide_delegate.") },
      required: ["threadId"],
    },
  },
];

import { THREAD_TOOL_DEFINITIONS } from "./threadTools.ts";
import { TASK_TOOL_DEFINITIONS } from "./taskTools.ts";

export const TOOL_DEFINITIONS: ToolDefinition[] = [...BASE_TOOL_DEFINITIONS, ...THREAD_TOOL_DEFINITIONS, ...TASK_TOOL_DEFINITIONS];
