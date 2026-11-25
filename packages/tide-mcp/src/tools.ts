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
      "Delegate a task to another harness (claude, codex, opencode, pi, antigravity, acp) in this repo or linked repositories. Async by default (wakes on finish); child sees only prompt.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["claude", "codex", "opencode", "pi", "antigravity", "acp"] },
        providerId: str("Instance id (e.g. codex:work)."),
        prompt: str("Task prompt."),
        model: str("Optional model id for that harness, exactly as tide_harnesses lists it."),
        mode: { type: "string", enum: ["approval-required", "auto-accept-edits", "auto", "full-access"], description: "Omit to inherit yours." },
        title: { type: "string" },
        useWorktree: { type: "boolean" },
        role: { type: "string" },
        completion: { type: "string", enum: ["async", "wait"] },
        timeoutMs: { type: "number" },
        clientRequestId: { type: "string" },
        repo: str("Linked repo label."),
        images: IMAGES_INPUT,
        inheritWorktreeFrom: str("Share threadId worktree."),
      },
      required: ["provider", "prompt"],
    },
  },
  {
    name: "tide_delegate_status",
    description:
      "Inspect a delegated thread's status and last assistant message. Do not poll this on a running delegate — completion wakes you automatically. Use it after a wake or only when explicitly asked to inspect a thread. `settled` stays false while background sub-agents still work (status reads \"working (N background sub-agents)\").",
    inputSchema: {
      type: "object",
      properties: { threadId: str("The threadId returned by tide_delegate.") },
      required: ["threadId"],
    },
  },
  {
    name: "tide_harnesses",
    description: "List the harnesses tide_delegate can run here: sign-in state, default model and model ids. Pass a model id to tide_delegate exactly as listed.",
    inputSchema: {
      type: "object",
      properties: { refresh: { type: "boolean", description: "Re-read every harness instead of the status cached up to a minute." } },
    },
  },
];

import { IMAGES_INPUT, THREAD_TOOL_DEFINITIONS } from "./threadTools.ts";
import { TASK_TOOL_DEFINITIONS } from "./taskTools.ts";
import { SECRET_TOOL_DEFINITIONS } from "./secretTools.ts";

export const TOOL_DEFINITIONS: ToolDefinition[] = [...BASE_TOOL_DEFINITIONS, ...THREAD_TOOL_DEFINITIONS, ...TASK_TOOL_DEFINITIONS, ...SECRET_TOOL_DEFINITIONS];
