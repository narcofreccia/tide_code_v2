import { ProviderKind, RuntimeMode, rpcMethods, type ReadModel, type Thread } from "@tide/contracts";
import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import type { Engine } from "../orchestration/engine.ts";
import { listHarnesses, type AgentHandlerDeps } from "../rpc/agent.ts";
import { threadDiff } from "../rpc/agentDiff.ts";
import {
  archiveThread, dispatchThreadCommand, interruptThread, listTasks, listThreads,
  pendingQuestions, readTimeline, respondToQuestion, sendThreadMessage, summarize,
} from "../rpc/agentThreads.ts";
import { RpcException } from "../rpc/router.ts";
import type { CheckpointService } from "../vcs/checkpoints.ts";
import { createProjectDirectory, PROJECT_NAME_PATTERN } from "./roots.ts";

interface RemoteToolDeps extends Pick<AgentHandlerDeps, "registry" | "providerDefaults"> {
  engine: Engine;
  checkpoints: CheckpointService;
  roots: readonly string[];
}

const project = Type.String({ minLength: 1 });
const threadCreate = Type.Object({
  projectId: project,
  provider: ProviderKind,
  providerId: Type.Optional(Type.String({ minLength: 1 })),
  model: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  useWorktree: Type.Optional(Type.Boolean()),
  mode: Type.Optional(RuntimeMode),
  prompt: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });
const projectCreate = Type.Object({
  name: Type.String({ pattern: PROJECT_NAME_PATTERN }),
  root: Type.Optional(Type.String({ minLength: 1 })),
  gitInit: Type.Optional(Type.Boolean({ default: true })),
}, { additionalProperties: false });

const only = { additionalProperties: false } as const;
const read = rpcMethods["agent.thread.read"].input;
const { imagePaths: _imagePaths, commandId, ...send } = rpcMethods["agent.thread.send"].input.properties;

function targetThread(model: ReadModel, id: string): Thread {
  const thread = Object.hasOwn(model.threads, id) ? model.threads[id] : undefined;
  if (thread === undefined) throw new RpcException("not-found", `unknown thread ${id}`);
  return thread;
}

interface Invocation {
  model: ReadModel;
  requireElevation: () => void;
}

function tool<T extends TSchema>(
  name: string,
  description: string,
  inputSchema: T,
  run: (input: Static<T>, invocation: Invocation) => object | Promise<object>,
) {
  return {
    definition: { name, description, inputSchema },
    async call(input: unknown, invocation: Invocation) {
      if (!Check(inputSchema, input)) throw new RpcException("invalid-params", Errors(inputSchema, input)[0]?.message ?? "invalid arguments");
      return run(input, invocation);
    },
  };
}

export function createRemoteTools({ engine, registry, providerDefaults, checkpoints, roots }: RemoteToolDeps) {
  const harnessDeps = { ...(registry && { registry }), ...(providerDefaults && { providerDefaults }) };
  const sendDeps = { engine, ...(registry && { registry }) };
  const authorizeDrive = (threadId: string, { requireElevation }: Invocation) => (model: ReadModel) => {
    if (targetThread(model, threadId).mode === "full-access") requireElevation();
  };

  const tools = [
    tool("tide_projects_list", "List active projects with their workspace directories and thread counts.", Type.Object({}, only), (_input, { model }) => {
      const counts = new Map<string, number>();
      for (const thread of Object.values(model.threads)) {
        if (thread.archivedAt === undefined) counts.set(thread.projectId, (counts.get(thread.projectId) ?? 0) + 1);
      }
      return {
        projects: Object.values(model.projects)
          .filter((p) => p.archivedAt === undefined)
          .map((p) => ({ id: p.id, name: p.title, cwd: p.rootPath, threadCount: counts.get(p.id) ?? 0 })),
      };
    }),
    tool("tide_harnesses", "List available harnesses, their default models and model IDs.", rpcMethods["agent.harnesses"].input,
      (input) => listHarnesses(harnessDeps, input.refresh === true)),
    tool("tide_thread_list", "List active threads, optionally filtered by project or title. Delegates are hidden unless requested.",
      rpcMethods["agent.thread.list"].input, (input, { model }) => listThreads(model, input)),
    tool("tide_thread_read", "Read a bounded page of messages or activity. Pass nextPosition as afterPosition to continue.",
      Type.Object({ ...read.properties, afterPosition: Type.Optional(Type.Integer({ minimum: -1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }, only),
      (input, { model }) => {
        const target = targetThread(model, input.threadId);
        return { thread: summarize(model, target), ...readTimeline(model, target.id, input) };
      }),
    tool("tide_thread_diff", "Get the diff for a thread, bounded per file.", rpcMethods["agent.thread.diff"].input,
      (input, { model }) => threadDiff(checkpoints, model, targetThread(model, input.threadId), input)),
    tool("tide_thread_create", "Create a thread in a project and optionally send its first prompt. Full-access mode requires 2FA elevation.", threadCreate,
      async ({ prompt, ...input }, invocation) => {
        if (input.mode === "full-access") invocation.requireElevation();
        const created = await dispatchThreadCommand(engine, { ...input, type: "thread.create", mode: input.mode ?? "approval-required" });
        const event = created.events.find((r) => r.event.type === "thread.created")?.event;
        if (event?.type !== "thread.created") throw new RpcException("internal", "thread.create produced no thread");
        const thread = event.thread;
        if (prompt === undefined) return { threadId: thread.id };
        const authorize = authorizeDrive(thread.id, invocation);
        const sent = await sendThreadMessage(sendDeps, thread, { threadId: thread.id, text: prompt, mode: "queue" }, { authorize });
        return { threadId: thread.id, ...sent };
      }),
    tool("tide_thread_send", "Send a message to a thread. Auto steers when supported, queue waits, and steer targets the running turn.",
      Type.Object({ ...send, clientRequestId: commandId }, only),
      ({ clientRequestId, ...input }, invocation) => {
        const target = targetThread(invocation.model, input.threadId);
        const authorize = authorizeDrive(target.id, invocation);
        authorize(invocation.model);
        return sendThreadMessage(sendDeps, target, { ...input, ...(clientRequestId !== undefined ? { commandId: JSON.stringify(["mcp.thread.send", target.id, clientRequestId]) } : {}) }, { authorize });
      }),
    tool("tide_thread_interrupt", "Interrupt a running thread.", rpcMethods["agent.thread.interrupt"].input,
      (input, { model }) => interruptThread(engine, targetThread(model, input.threadId))),
    tool("tide_thread_archive", "Archive a finished thread and clean up its worktree unless keepWorktree is set.",
      rpcMethods["agent.thread.archive"].input, (input, { model }) => archiveThread(engine, model, targetThread(model, input.threadId), input)),
    tool("tide_pending_list", "List pending questions on a thread.", rpcMethods["agent.pending.list"].input,
      (input, { model }) => pendingQuestions(model, targetThread(model, input.threadId))),
    tool("tide_pending_respond", "Answer a pending question using question IDs as keys.", rpcMethods["agent.pending.respond"].input,
      (input, invocation) => {
        const target = targetThread(invocation.model, input.threadId);
        const authorize = authorizeDrive(target.id, invocation);
        authorize(invocation.model);
        return respondToQuestion(engine, invocation.model, target, input, authorize);
      }),
    tool("tide_list_scheduled_tasks", "List scheduled tasks, optionally filtered by project.", Type.Object({ projectId: Type.Optional(project) }, only),
      (input, { model }) => listTasks(model, input.projectId)),
    tool("tide_project_create", "Create and register a new directory under an allowed project root. Git initialization defaults to true. Requires 2FA elevation.",
      projectCreate, async (input, { requireElevation }) => {
        requireElevation();
        const rootPath = createProjectDirectory(roots, input.name, input.root, input.gitInit);
        const result = await dispatchThreadCommand(engine, { type: "project.create", title: input.name, rootPath });
        const created = result.events.find((r) => r.event.type === "project.created")?.event;
        if (created?.type !== "project.created") throw new RpcException("internal", "project.create produced no project");
        return { projectId: created.project.id, rootPath };
      }),
  ];
  const byName = new Map(tools.map((entry) => [entry.definition.name, entry]));
  return {
    definitions: tools.map((entry) => entry.definition),
    call(name: string, args: unknown, requireElevation: () => void) {
      const entry = byName.get(name);
      if (entry === undefined) throw new RpcException("not-found", `unknown tool ${name}`);
      return entry.call(args, { model: engine.getModel(), requireElevation });
    },
  };
}
