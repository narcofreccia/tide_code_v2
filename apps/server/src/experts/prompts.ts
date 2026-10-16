import type { ExpertsFinding, ExpertsMessage, ExpertsSession, ExpertState, Team } from "@tide/contracts";
import { stageSources } from "../teams/stages.ts";

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
export function delegatePrompt(prompt: string, fromTitle: string, role?: string): string {
  const framing = role !== undefined && role.trim() !== "" ? [`You act as the ${role.trim()} for thread "${fromTitle}"; stay within that role.`] : [];
  return [
    `You were delegated this task by another Tide thread ("${fromTitle}"). Complete it and finish with a short summary of what you did and what you found.`,
    ...framing,
    prompt,
  ].join("\n\n");
}

/** Board message delivered to an idle expert/lead thread as a new turn. */
export function messageDeliveryPrompt(from: string, text: string): string {
  return `Message from ${from}: ${text}`;
}

/** The longest single `tide_delegate`/`tide_thread_wait` wait the server accepts (agent.thread.wait). */
export const TEAM_WAIT_MS = 600_000;

/**
 * The lead's first message on a team run: the task, then for every later stage the exact
 * `tide_delegate` call to make. The server never runs stages itself — the lead does, through
 * its own harness and the Tide MCP tools. `leadThreadId` lets a stage inherit the lead's checkout.
 */
export function teamBrief(team: Pick<Team, "name" | "stages">, task: string, leadThreadId?: string): string {
  const resolved = stageSources(team);
  const sources = "sources" in resolved ? resolved.sources : [];
  const [lead, ...rest] = team.stages;
  if (lead === undefined) return task;
  const keyOf = (index: number): string => team.stages[index]?.key ?? "?";
  const lines: string[] = [
    `You lead the team "${team.name}". The task:`,
    task,
    `The team has ${team.stages.length} stage${team.stages.length === 1 ? "" : "s"}. You are stage 1 ("${lead.key}"), the ${lead.role}, on ${lead.provider}. Do your own part of the task first.`,
    ...(lead.instructions !== undefined && lead.instructions.trim() !== "" ? [`Instructions for you: ${lead.instructions.trim()}`] : []),
  ];
  if (rest.length === 0) {
    lines.push("There are no further stages: do the whole task yourself and finish with a short report.");
    return lines.join("\n\n");
  }
  lines.push(
    [
      "Then run every later stage, in order, by calling `tide_delegate` with exactly the arguments listed for it. Write each `prompt` yourself: the stage's thread has none of your context, so include the task, your plan, and what the earlier stages reported.",
      `\`tide_delegate\` returns a JSON line with the new thread's \`threadId\`; note it, later stages refer to it. If the result says \`waitTimedOut\`, the stage is still working: keep calling \`tide_thread_wait\` with that threadId (timeoutMs ${TEAM_WAIT_MS}) until it reports settled. Never start a stage before the previous one has settled.`,
    ].join(" "),
  );
  for (const [offset, stage] of rest.entries()) {
    const index = offset + 1;
    const source = sources[index];
    const args: Record<string, unknown> = {
      provider: stage.provider,
      role: stage.role,
      ...(stage.model !== undefined ? { model: stage.model } : {}),
      ...(stage.mode !== undefined ? { mode: stage.mode } : {}),
      title: `${team.name}: ${stage.role}`,
      ...(source === undefined
        ? { useWorktree: true }
        : { inheritWorktreeFrom: source === 0 && leadThreadId !== undefined ? leadThreadId : `<threadId of stage "${keyOf(source)}">` }),
      completion: "wait",
      timeoutMs: TEAM_WAIT_MS,
      prompt: "<the self-contained task for this stage>",
    };
    const where = source === undefined ? "in its own worktree" : `in the checkout of stage "${keyOf(source)}"${source === 0 ? " (yours)" : ""}`;
    const stageLines = [
      `Stage ${index + 1} ("${stage.key}"): the ${stage.role}, on ${stage.provider}, ${where}.`,
      `tide_delegate ${JSON.stringify(args)}`,
    ];
    if (source !== undefined) {
      stageLines.push(
        `Tell it the threadId of stage "${keyOf(source)}" and that \`tide_thread_diff\` with that threadId shows what that stage changed; it works on the same branch, so its findings are about that work.`,
      );
    }
    if (stage.interaction === "plan") stageLines.push("This stage plans only: its prompt must ask for a plan and no file edits.");
    if (stage.instructions !== undefined && stage.instructions.trim() !== "") stageLines.push(`Instructions for this stage (put them in its prompt): ${stage.instructions.trim()}`);
    lines.push(stageLines.join("\n"));
  }
  lines.push(
    [
      "Never skip a stage, and never skip a review or test stage even when the change looks trivial.",
      "If a review or test stage finds problems, send them to the stage that made the change with `tide_thread_send`, wait for it with `tide_thread_wait`, then run the review or test stage again (at most twice).",
      "When every stage has settled, finish with a report that lists each stage (key, role, harness, threadId) and its outcome, and says which thread holds the branch to merge.",
    ].join(" "),
  );
  return lines.join("\n\n");
}
