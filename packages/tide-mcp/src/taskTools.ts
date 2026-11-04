// Scheduled-task (automation) tools. The server stamps projectId and scopes every command to
// the calling thread's project, so an agent can only touch its own project's tasks.
import type { AgentCommand } from "@tide/contracts";
import type { AgentBackend } from "./backend.ts";
import type { TextResult, ToolDef } from "./threadTools.ts";

const str = (description: string): Record<string, unknown> => ({ type: "string", description });
const ok = (value: string): TextResult => ({ content: [{ type: "text", text: value }] });

const SCHEDULE_SCHEMA = {
  description:
    'When to run: {kind:"interval", everyMinutes} (minimum 1) or {kind:"fixed", times:["HH:MM",...], weekdays:[0-6]} with 0 = Sunday, server time zone, or {kind:"once", at} to run a single time (at = ISO 8601 date-time such as "2026-11-06T14:30" in server local time, or epoch milliseconds; must be in the future; the automation disables itself after it runs).',
  type: "object",
  properties: {
    kind: { type: "string", enum: ["interval", "fixed", "once"] },
    at: { description: "once: ISO 8601 date-time or epoch milliseconds.", oneOf: [{ type: "string" }, { type: "number" }] },
    everyMinutes: { type: "number" },
    times: { type: "array", items: { type: "string" } },
    weekdays: { type: "array", items: { type: "number" } },
  },
  required: ["kind"],
};

const TARGET_PROPS = {
  threadId: str("Send into this existing thread (queued, never interrupting). Omit to start a new thread on every run."),
  provider: str("New-thread runs: claude | codex | opencode | pi. Defaults to the project's default."),
  model: str("New-thread runs: model id; defaults to the harness default."),
  useWorktree: { type: "boolean", description: "New-thread runs: use a git worktree (default true)." },
};

export const TASK_TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: "tide_schedule_task",
    description:
      "Create an automation: a prompt Tide sends on a schedule, either into an existing thread or as a new thread each run. Use it when the user asks for something recurring (a daily review, a periodic check). Pass clientRequestId so a retry does not create it twice.",
    inputSchema: {
      type: "object",
      properties: {
        title: str("Short name."),
        prompt: str("The prompt to send on each run."),
        schedule: SCHEDULE_SCHEMA,
        ...TARGET_PROPS,
        clientRequestId: str("Idempotency key."),
      },
      required: ["title", "prompt", "schedule"],
    },
  },
  {
    name: "tide_list_scheduled_tasks",
    description: "List this project's automations. Currently unavailable to agents: the server has no agent-readable task listing. Ask the user to open Settings > Automations.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "tide_update_scheduled_task",
    description: "Change an automation (only the fields you pass). Set enabled=false to pause it.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: str("Task id."),
        title: str("New title."),
        prompt: str("New prompt."),
        schedule: SCHEDULE_SCHEMA,
        enabled: { type: "boolean", description: "Pause or resume." },
        ...TARGET_PROPS,
        clientRequestId: str("Idempotency key."),
      },
      required: ["taskId"],
    },
  },
  {
    name: "tide_delete_scheduled_task",
    description: "Delete an automation. Threads it already created are kept.",
    inputSchema: { type: "object", properties: { taskId: str("Task id."), clientRequestId: str("Idempotency key.") }, required: ["taskId"] },
  },
  {
    name: "tide_run_scheduled_task_now",
    description: "Fire an automation once right now, outside its schedule (its next scheduled run is unchanged).",
    inputSchema: { type: "object", properties: { taskId: str("Task id."), clientRequestId: str("Idempotency key.") }, required: ["taskId"] },
  },
];

const NAMES = new Set(TASK_TOOL_DEFINITIONS.map((d) => d.name));
export const isTaskTool = (name: string): boolean => NAMES.has(name);

const optStr = (a: Record<string, unknown>, k: string): string | undefined => (typeof a[k] === "string" && a[k] !== "" ? (a[k] as string) : undefined);
function reqStr(a: Record<string, unknown>, k: string): string {
  const v = optStr(a, k);
  if (v === undefined) throw new Error(`\`${k}\` is required`);
  return v;
}

type Schedule = Extract<AgentCommand, { type: "task.create" }>["schedule"];

export function parseSchedule(raw: unknown): Schedule {
  if (typeof raw !== "object" || raw === null) throw new Error("`schedule` is required");
  const s = raw as Record<string, unknown>;
  if (s["kind"] === "interval") {
    const m = s["everyMinutes"];
    if (typeof m !== "number" || !Number.isFinite(m) || m < 1) throw new Error("`schedule.everyMinutes` must be a number >= 1");
    return { kind: "interval", everyMs: Math.round(m * 60_000) };
  }
  if (s["kind"] === "fixed") {
    const times = s["times"];
    const weekdays = s["weekdays"];
    if (!Array.isArray(times) || times.length === 0 || !times.every((t) => typeof t === "string" && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(t))) {
      throw new Error('`schedule.times` must be a non-empty list of "HH:MM" strings');
    }
    if (!Array.isArray(weekdays) || weekdays.length === 0 || !weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      throw new Error("`schedule.weekdays` must be a non-empty list of 0-6 (0 = Sunday)");
    }
    return { kind: "fixed", times: times as string[], weekdays: weekdays as number[] };
  }
  if (s["kind"] === "once") {
    const raw = s["at"];
    const at = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Date.parse(raw) : Number.NaN;
    if (!Number.isFinite(at) || at < 0) throw new Error("`schedule.at` must be an ISO 8601 date-time or epoch milliseconds");
    return { kind: "once", at: Math.round(at) };
  }
  throw new Error('`schedule.kind` must be "interval", "fixed" or "once"');
}

function targetFields(args: Record<string, unknown>) {
  const threadId = optStr(args, "threadId");
  const provider = optStr(args, "provider");
  const model = optStr(args, "model");
  return {
    ...(threadId !== undefined ? { threadId } : {}),
    ...(provider !== undefined ? { provider: provider as NonNullable<Extract<AgentCommand, { type: "task.create" }>["provider"]> } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(typeof args["useWorktree"] === "boolean" ? { useWorktree: args["useWorktree"] } : {}),
  };
}

/** Handles tide_*_scheduled_task*; throws raw errors (the caller maps them). */
export async function callTaskTool(backend: AgentBackend, name: string, args: Record<string, unknown>): Promise<TextResult> {
  const commandId = optStr(args, "clientRequestId");
  const cid = commandId !== undefined ? { commandId } : {};
  switch (name) {
    case "tide_schedule_task": {
      const r = await backend.dispatch({
        type: "task.create",
        // stamped server-side with the calling thread's project
        projectId: "self",
        title: reqStr(args, "title"),
        prompt: reqStr(args, "prompt"),
        schedule: parseSchedule(args["schedule"]),
        ...targetFields(args),
        ...cid,
      });
      const created = r.events.find((e) => e.event.type === "task.created");
      const id = created?.event.type === "task.created" ? created.event.task.id : undefined;
      return ok(id === undefined ? "Automation created." : `Automation created. taskId=${id}`);
    }
    case "tide_list_scheduled_tasks": {
      const { tasks } = await backend.taskList();
      if (tasks.length === 0) return ok("No automations on this project.");
      const lines = tasks.map((t) => {
        const s = t.schedule;
        const when =
          s.kind === "interval" ? `every ${Math.round(s.everyMs / 60000)} min`
          : s.kind === "webhook" ? `webhook /hook/${s.hookId}`
          : s.kind === "once" ? `once at ${new Date(s.at).toISOString()}`
          : `${s.times.join(",")} on days ${s.weekdays.join(",")}`;
        const target = t.threadId !== undefined ? `thread ${t.threadId}` : `new thread${t.provider !== undefined ? ` on ${t.provider}` : ""}`;
        return `${t.id} | ${t.title} | ${when} | ${target} | ${t.enabled ? "enabled" : "paused"} | runs=${t.runs}${t.nextRunAt !== undefined ? ` | next=${new Date(t.nextRunAt).toISOString()}` : ""}`;
      });
      return ok(`taskId | title | schedule | target | state | runs | next\n${lines.join("\n")}`);
    }
    case "tide_update_scheduled_task": {
      const title = optStr(args, "title");
      const prompt = optStr(args, "prompt");
      await backend.dispatch({
        type: "task.update",
        taskId: reqStr(args, "taskId"),
        ...(title !== undefined ? { title } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(args["schedule"] !== undefined ? { schedule: parseSchedule(args["schedule"]) } : {}),
        ...(typeof args["enabled"] === "boolean" ? { enabled: args["enabled"] } : {}),
        ...targetFields(args),
        ...cid,
      });
      return ok("Automation updated.");
    }
    case "tide_delete_scheduled_task":
      await backend.dispatch({ type: "task.delete", taskId: reqStr(args, "taskId"), ...cid });
      return ok("Automation deleted.");
    case "tide_run_scheduled_task_now":
      await backend.dispatch({ type: "task.run-now", taskId: reqStr(args, "taskId"), ...cid });
      return ok("Automation fired.");
    default:
      throw new Error(`unknown tool ${name}`);
  }
}
