import type { ExpertsFinding, ExpertsMessage, ExpertsSession, ExpertState } from "@tide/contracts";

// Pure prompt builders for the Experts panel. Kept free of ids and clocks so the
// decider stays a pure function and the wording is unit-testable.

const TOOLS = {
  finding: "tide_experts_post_finding",
  message: "tide_experts_send_message",
  check: "tide_experts_check_messages",
  read: "tide_experts_read_findings",
  synthesize: "tide_experts_synthesize",
} as const;

function describe(expert: Pick<ExpertState, "name" | "role">): string {
  return `${expert.name} (${expert.role})`;
}

/** "Alice (types), Bob (perf)" — everyone on the panel except `self`. */
export function colleagueList(session: Pick<ExpertsSession, "experts">, selfKey?: string): string {
  const others = session.experts.filter((e) => e.key !== selfKey).map(describe);
  return others.length === 0 ? "none" : others.join(", ");
}

export function formatFindings(findings: readonly ExpertsFinding[]): string {
  if (findings.length === 0) return "(no findings posted yet)";
  return findings.map((f) => `- [${f.author}] ${f.text}`).join("\n");
}

export function formatMessages(messages: readonly ExpertsMessage[]): string {
  if (messages.length === 0) return "(no discussion yet)";
  return messages.map((m) => `- ${m.from} -> ${m.to}: ${m.text}`).join("\n");
}

const READ_ONLY = "Explore the repository read-only. Do not edit files.";

export function explorationPrompt(session: Pick<ExpertsSession, "topic" | "experts">, expert: ExpertState): string {
  return [
    `You are ${expert.name}, ${expert.role}, part of a panel of experts examining: ${session.topic}.`,
    `Other experts on the panel: ${colleagueList(session, expert.key)}.`,
    expert.persona ?? "",
    READ_ONLY,
    `Post each substantive finding with the \`${TOOLS.finding}\` tool (short, concrete, cite paths).`,
    `You can message a colleague with \`${TOOLS.message}\` and read new messages with \`${TOOLS.check}\`.`,
    `Use \`${TOOLS.read}\` to see what the others have posted.`,
    "Work independently; post findings as you go rather than in one dump at the end.",
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");
}

export function discussionPrompt(
  session: Pick<ExpertsSession, "topic" | "experts">,
  expert: ExpertState,
  findings: readonly ExpertsFinding[],
): string {
  return [
    `Discussion phase for the panel on: ${session.topic}.`,
    `You are ${expert.name}, ${expert.role}. Other experts: ${colleagueList(session, expert.key)}.`,
    "Here are all findings so far:",
    formatFindings(findings),
    "Challenge, agree, refine. Where a finding is wrong or incomplete, say so and explain why.",
    `Post refined findings with \`${TOOLS.finding}\`. Message specific colleagues with \`${TOOLS.message}\` when you disagree, and check replies with \`${TOOLS.check}\`.`,
    READ_ONLY,
  ].join("\n\n");
}

export function synthesisPrompt(
  session: Pick<ExpertsSession, "topic" | "experts">,
  findings: readonly ExpertsFinding[],
  messages: readonly ExpertsMessage[],
): string {
  return [
    `You are the lead of a panel of experts on: ${session.topic}.`,
    `Panel: ${colleagueList(session)}.`,
    "Findings:",
    formatFindings(findings),
    "Discussion:",
    formatMessages(messages),
    "Synthesize the panel's findings and discussion into a decision document with a recommended plan: the decision, the reasoning, the trade-offs the panel disagreed on, and concrete implementation steps.",
    `When the document is ready, call \`${TOOLS.synthesize}\` with the full markdown. Do not implement anything.`,
  ].join("\n\n");
}

/** Prompt for a thread another agent delegated via tide_delegate. */
export function delegatePrompt(prompt: string, fromTitle: string): string {
  return [
    `You were delegated this task by another Tide thread ("${fromTitle}"). Complete it and finish with a short summary of what you did and what you found.`,
    prompt,
  ].join("\n\n");
}

/** Board message delivered to an idle expert/lead thread as a new turn. */
export function messageDeliveryPrompt(from: string, text: string): string {
  return `Message from ${from}: ${text}`;
}
