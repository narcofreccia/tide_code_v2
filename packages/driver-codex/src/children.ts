import type { DriverActivity, NormalizedEvent } from "@tide/contracts";
import { toolActivity, toolStatus, truncate } from "./items.ts";
import type { CollabAgentStatus } from "./generated/v2/CollabAgentStatus.ts";
import type { ThreadItem } from "./generated/v2/ThreadItem.ts";
import type { TurnCompletedNotification } from "./generated/v2/TurnCompletedNotification.ts";

type ChildStatus = "running" | "done" | "error";
type CollabItem = Extract<ThreadItem, { type: "collabAgentToolCall" }>;
type SubAgentItem = Extract<ThreadItem, { type: "subAgentActivity" }>;

/** `report` on a child row is capped at 8 KB by the driver (contracts `ChildActivity.report`). */
const MAX_REPORT_CHARS = 8192;
/** Name shown until the child's nickname or agent path is known. */
const PLACEHOLDER_NAME = "sub-agent";

interface ChildRow {
  name: string;
  status: ChildStatus;
  description?: string;
  summary?: string;
  report?: string;
  /** the child thread that spawned this one; undefined when the session's own thread did */
  parent?: string;
  /** last emitted row, so repeated reports of the same state emit nothing */
  last?: string;
}

/** CollabAgentStatus (0.170 bindings) onto the child row's three states. */
function stateStatus(status: CollabAgentStatus): ChildStatus {
  if (status === "pendingInit" || status === "running") return "running";
  if (status === "completed" || status === "shutdown") return "done";
  return "error"; // interrupted | errored | notFound
}

/**
 * Codex sub-agents run in child threads of the session's thread. Every row that comes from a
 * child thread is stamped `parentToolUseId = <child thread id>`, which is also the child row's
 * `childKey`, so the UI and the server nest it under that row.
 *
 * The row's status follows the child itself: its own `turn/started` / `turn/completed`,
 * `subAgentActivity` items and the `agentsStates` reported on collab tool calls. The collab
 * call's own status is not used for it: `spawnAgent` completes as soon as the agent exists.
 */
export class CodexChildren {
  #rows = new Map<string, ChildRow>();

  has(threadId: string): boolean {
    return this.#rows.has(threadId);
  }

  /** `parentToolUseId` for anything produced in `threadId`: the child's own id, or nothing for the main thread. */
  parentFor(threadId: string | undefined): string | undefined {
    return threadId !== undefined && this.#rows.has(threadId) ? threadId : undefined;
  }

  /** `thread/started` for a thread whose parent is the session's thread or one of its children. */
  announced(thread: { id: string; parentThreadId?: string | null; agentNickname?: string | null }, mainThreadId: string | undefined): NormalizedEvent[] {
    const parentId = thread.parentThreadId ?? undefined;
    if (parentId === undefined || (parentId !== mainThreadId && !this.#rows.has(parentId))) return [];
    const row = this.#row(thread.id, this.parentFor(parentId));
    if (thread.agentNickname && row.name === PLACEHOLDER_NAME) row.name = thread.agentNickname;
    return this.#emit(thread.id);
  }

  collab(item: CollabItem, parent: string | undefined): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    const spawn = item.tool === "spawnAgent" && item.receiverThreadIds.length > 0;
    // Every call but a spawn is a tool call of the thread that made it (wait, sendInput, closeAgent…).
    if (!spawn) {
      events.push({
        type: "activity",
        activity: toolActivity(
          {
            toolUseId: item.id,
            toolName: item.tool,
            input: { receiverThreadIds: item.receiverThreadIds, ...(item.prompt ? { prompt: truncate(item.prompt, 500) } : {}) },
            status: toolStatus(item.status),
          },
          parent,
        ),
      });
    }
    for (const child of item.receiverThreadIds) {
      const known = this.#rows.has(child);
      // Only a spawn creates a row; other tools only update the children they report on.
      if (!known && !spawn) continue;
      const row = this.#row(child, parent);
      if (spawn && !known && item.prompt) row.description = truncate(item.prompt, 500);
      if (spawn && item.status === "failed") row.status = "error";
      const state = item.agentsStates[child];
      if (state) {
        const status = stateStatus(state.status);
        // a stale "running" report must not reopen a child that already finished
        if (!(status === "running" && row.status !== "running")) row.status = status;
        if (state.message) row.summary = truncate(state.message, 1000);
      }
      events.push(...this.#emit(child));
    }
    return events;
  }

  subAgent(item: SubAgentItem, parent: string | undefined): NormalizedEvent[] {
    const known = this.#rows.has(item.agentThreadId);
    const row = this.#row(item.agentThreadId, parent);
    if (!known || row.name === PLACEHOLDER_NAME) row.name = item.agentPath;
    if (item.kind === "started") row.status = "running";
    else if (item.kind === "completed") row.status = "done";
    else if (item.kind === "interrupted") row.status = "error";
    return this.#emit(item.agentThreadId);
  }

  turnStarted(threadId: string): NormalizedEvent[] {
    const row = this.#rows.get(threadId);
    if (!row) return [];
    row.status = "running";
    return this.#emit(threadId);
  }

  turnCompleted(threadId: string, turn: TurnCompletedNotification["turn"] | undefined): NormalizedEvent[] {
    const row = this.#rows.get(threadId);
    if (!row) return [];
    if (turn?.status === "completed") row.status = "done";
    else {
      row.status = "error";
      const reason = turn?.status === "interrupted" ? "interrupted" : (turn?.error?.message ?? `turn ${turn?.status ?? "failed"}`);
      row.summary = truncate(reason, 1000);
    }
    return this.#emit(threadId);
  }

  /** A child's todo list shows on its row, not as the thread's own plan progress. */
  planUpdated(threadId: string, plan: unknown): NormalizedEvent[] {
    const row = this.#rows.get(threadId);
    if (!row || !Array.isArray(plan) || plan.length === 0) return [];
    const steps = plan as { step?: unknown; status?: unknown }[];
    const done = steps.filter((step) => step.status === "completed").length;
    const current = steps.find((step) => step.status === "inProgress")?.step;
    row.summary = truncate(`Plan ${done}/${steps.length}${typeof current === "string" ? `: ${current}` : ""}`, 1000);
    return this.#emit(threadId);
  }

  /** The child's latest finished message is its report. */
  message(threadId: string, text: string): NormalizedEvent[] {
    const row = this.#rows.get(threadId);
    if (!row || text === "") return [];
    row.report = text.length <= MAX_REPORT_CHARS ? text : `${text.slice(0, MAX_REPORT_CHARS - 1)}…`;
    return this.#emit(threadId);
  }

  #row(childId: string, parent: string | undefined): ChildRow {
    let row = this.#rows.get(childId);
    if (!row) {
      row = { name: PLACEHOLDER_NAME, status: "running", ...(parent !== undefined ? { parent } : {}) };
      this.#rows.set(childId, row);
    }
    return row;
  }

  #emit(childId: string): NormalizedEvent[] {
    const row = this.#rows.get(childId);
    if (!row) return [];
    const activity: DriverActivity = {
      kind: "child",
      childKey: childId,
      name: row.name,
      status: row.status,
      childThreadId: childId,
      ...(row.description !== undefined ? { description: row.description } : {}),
      ...(row.summary !== undefined ? { summary: row.summary } : {}),
      ...(row.report !== undefined ? { report: row.report } : {}),
      ...(row.parent !== undefined ? { parentToolUseId: row.parent } : {}),
    };
    const key = JSON.stringify(activity);
    if (key === row.last) return [];
    row.last = key;
    return [{ type: "activity", activity }];
  }
}
