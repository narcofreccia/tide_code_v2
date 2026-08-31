import type { LinkedDir, Project, Thread } from "@tide/contracts";

/**
 * W1 "linked repos": Claude Code's `--add-dir` made durable and cross-harness.
 *
 * A thread's links are `thread.links × project.links`. Links always point at the linked
 * repository's *real* path — a thread running in a worktree still reaches the link's own
 * checkout, because a link is a different repo, not a different branch of this one.
 */
export function resolveLinkedDirs(thread: Thread, project: Project): LinkedDir[] {
  const available = project.links ?? [];
  if (available.length === 0) return [];
  // No per-thread selection recorded (thread created before its project had links):
  // fall back to every project link at its default access.
  const selection = thread.links ?? available.map((l) => ({ linkId: l.id, access: l.access }));
  const dirs: LinkedDir[] = [];
  for (const want of selection) {
    const link = available.find((l) => l.id === want.linkId);
    if (!link) continue; // the link was removed from the project since this thread was created
    dirs.push({
      path: link.path,
      label: link.label,
      ...(link.note !== undefined ? { note: link.note } : {}),
      // a thread can never hold more access than the project link grants
      access: link.access === "read" || want.access === "read" ? "read" : "write",
    });
  }
  return dirs;
}

/**
 * The one place the agent is *told* about its links. Every driver receives it through
 * `systemPromptAppend`, which maps to Claude's system-prompt append, Codex's
 * `developerInstructions`, OpenCode's prompt `system` and pi's `before_agent_start`.
 */
export function linkedRepoPreamble(project: Project, dirs: LinkedDir[]): string | undefined {
  if (dirs.length === 0) return undefined;
  const lines = dirs.map((dir) => {
    const access = dir.access === "write" ? "read & write" : "read-only";
    return `- ${dir.label} — ${dir.path} (${access})${dir.note ? `: ${dir.note}` : ""}`;
  });
  return [
    "## Linked repositories",
    `This project (${project.title}) is linked to other repositories you may need:`,
    ...lines,
    "Use absolute paths when reading or editing them. Read-only links must not be modified.",
  ].join("\n");
}

/** Joins the blocks Tide appends to the harness's own system prompt, in order. */
export function composeSystemPromptAppend(...parts: (string | undefined)[]): string | undefined {
  const blocks = parts.filter((part): part is string => part !== undefined && part.trim() !== "");
  return blocks.length === 0 ? undefined : blocks.join("\n\n");
}
