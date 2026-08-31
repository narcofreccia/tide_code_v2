// Plain JSON Schema tool definitions — no zod, no TypeBox, so this package stays a thin
// bridge. Descriptions say *when* to reach for the tool, because that is what the model
// actually reads.

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

const str = (description: string): Record<string, unknown> => ({ type: "string", description });

export const TOOL_DEFINITIONS: ToolDefinition[] = [
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
      "Hand a self-contained task to another coding harness as a new Tide thread, and get back its threadId. Use it for work that is worth running in parallel or that another harness is better at. Pass `repo` with the label of one of this project's linked repositories to run the delegate inside that repository instead. It returns immediately: poll tide_delegate_status for the result.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["claude", "codex", "opencode", "pi"], description: "Which harness runs the task." },
        prompt: str("The complete task description; the new thread has none of your context."),
        model: str("Optional model id for that harness."),
        mode: {
          type: "string",
          enum: ["approval-required", "auto-accept-edits", "auto", "full-access"],
          description: "Permission mode for the new thread. Defaults to auto.",
        },
        title: str("Optional short title for the new thread."),
        useWorktree: { type: "boolean", description: "Run the task in its own git worktree." },
        repo: str("Label of a linked repository to run the delegate in; it becomes that thread's main repo. Omit to use this project's repo."),
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
