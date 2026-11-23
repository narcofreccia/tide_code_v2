import type { AgentCommand, ExpertsSession, ReadModel, RpcOutput, Thread, UserSettings } from "@tide/contracts";
import { CommandError, type Engine } from "../orchestration/engine.ts";
import { agentStatus, isQuiescent } from "../orchestration/background.ts";
import { lastAssistantText } from "../orchestration/delegation.ts";
import { readImagePaths } from "../workspace/attachments.ts";
import { resolveCommandModel, toAgentHarness, type AgentRegistryView } from "./agentModel.ts";
import { notFoundThreadMessage } from "./agentThreads.ts";
import { RpcException, type RpcCallContext, type RpcRouter } from "./router.ts";
import { threadCwdResolver } from "./threadCwd.ts";

export interface AgentHandlerDeps {
  engine: Engine;
  /** R22: thread -> cwd, where `imagePaths` are read from (default: from the read model) */
  cwdFor?: (threadId: string) => string;
  /** R23: harness status for model checks and `agent.harnesses`; without it models pass unchecked */
  registry?: AgentRegistryView;
  /** R23: the user's Settings › Providers defaults (`agent.harnesses` defaultModel) */
  providerDefaults?: () => UserSettings["providerDefaults"];
}

interface Caller {
  thread: Thread;
  /** expert key, or "lead" */
  identity: string | undefined;
  session: ExpertsSession | undefined;
}

function callerOf(model: ReadModel, ctx: RpcCallContext): Caller {
  const threadId = ctx.agentThreadId;
  if (threadId === undefined) throw new RpcException("forbidden", "agent methods require an agent token");
  const thread = model.threads[threadId];
  if (!thread) throw new RpcException("not-found", `unknown thread ${threadId}`);
  const session = thread.expertsSessionId === undefined ? undefined : model.expertsSessions[thread.expertsSessionId];
  let identity: string | undefined;
  if (session) {
    if (thread.role === "lead" && session.lead.threadId === thread.id) identity = "lead";
    else identity = session.experts.find((e) => e.threadId === thread.id)?.key;
  }
  return { thread, identity, session };
}

/** The session an experts command claims must be the caller's own. */
function requireSession(caller: Caller, sessionId: string): { session: ExpertsSession; identity: string } {
  if (!caller.session || caller.session.id !== sessionId || caller.identity === undefined) {
    throw new RpcException("forbidden", `thread ${caller.thread.id} is not part of experts session ${sessionId}`);
  }
  return { session: caller.session, identity: caller.identity };
}

/** Rewrites the agent's command with the identity the socket proves; payload claims are ignored. */
function stampIdentity(command: AgentCommand, caller: Caller, model: ReadModel): AgentCommand {
  switch (command.type) {
    case "experts.finding.post": {
      const { identity } = requireSession(caller, command.sessionId);
      return { ...command, author: identity };
    }
    case "experts.message.send": {
      const { identity } = requireSession(caller, command.sessionId);
      return { ...command, from: identity };
    }
    case "experts.synthesis.set": {
      const { identity } = requireSession(caller, command.sessionId);
      if (identity !== "lead") throw new RpcException("forbidden", "only the panel lead can set the synthesis");
      return command;
    }
    case "thread.delegate": {
      // R22: images reach a delegate only as `imagePaths` read from the caller's checkout
      const { images: _wire, ...rest } = command;
      return { ...rest, fromThreadId: caller.thread.id };
    }
    case "task.create":
      return { ...command, projectId: caller.thread.projectId, createdByThreadId: caller.thread.id };
    case "task.update":
    case "task.delete":
    case "task.run-now": {
      const task = model.scheduledTasks[command.taskId];
      if (task && task.projectId !== caller.thread.projectId) {
        throw new RpcException("forbidden", `task ${task.id} belongs to another project`);
      }
      return command;
    }
  }
}

export function registerAgentHandlers(router: RpcRouter, deps: AgentHandlerDeps): void {
  const cwdFor = deps.cwdFor ?? threadCwdResolver(deps.engine);
  router.register("agent.dispatch", async (input, ctx) => {
    const model = deps.engine.getModel();
    const caller = callerOf(model, ctx);
    let command = stampIdentity(input.command, caller, model);
    const imagePaths = input.imagePaths ?? [];
    if (imagePaths.length > 0) {
      if (command.type !== "thread.delegate") throw new RpcException("invalid-params", `imagePaths only go with thread.delegate, not ${command.type}`);
      command = { ...command, images: await readImagePaths(cwdFor(caller.thread.id), imagePaths) };
    }
    let modelNote: string | undefined;
    if (deps.registry !== undefined) ({ command, modelNote } = await resolveCommandModel(command, deps.registry));
    try {
      const result = await deps.engine.dispatch(command);
      return modelNote !== undefined ? { ...result, modelNote } : result;
    } catch (err) {
      if (err instanceof CommandError) throw new RpcException(err.code, err.message);
      throw err;
    }
  });

  router.register("agent.harnesses", async (input, ctx) => {
    callerOf(deps.engine.getModel(), ctx);
    if (deps.registry === undefined) return { harnesses: [] };
    const defaults = deps.providerDefaults?.() ?? {};
    const dtos = await deps.registry.statusAll(input.refresh === true);
    return { harnesses: dtos.map((dto) => toAgentHarness(dto, defaults)) };
  });

  router.register("agent.context", async (input, ctx) => {
    const model = deps.engine.getModel();
    const caller = callerOf(model, ctx);
    const out: RpcOutput<"agent.context"> = {
      threadId: caller.thread.id,
      ...(caller.thread.role !== undefined ? { role: caller.thread.role } : {}),
      ...(caller.identity !== undefined && caller.identity !== "lead" ? { expertKey: caller.identity } : {}),
      findings: [],
      messages: [],
    };
    const session = caller.session;
    if (!session) return out;
    out.session = {
      id: session.id,
      topic: session.topic,
      phase: session.phase,
      experts: session.experts.map((e) => ({ key: e.key, name: e.name, role: e.role, provider: e.provider, status: e.status })),
    };
    out.findings = session.findingIds.flatMap((id) => {
      const f = model.expertsFindings[id];
      return f ? [{ id: f.id, author: f.author, text: f.text, createdAt: f.createdAt }] : [];
    });
    const since = input.sinceMessageId === undefined ? -1 : session.messageIds.indexOf(input.sinceMessageId);
    out.messages = session.messageIds.slice(since + 1).flatMap((id) => {
      const m = model.expertsMessages[id];
      if (!m) return [];
      // everything on the board that is addressed to this agent (or to everyone)
      if (m.to !== "all" && m.to !== caller.identity) return [];
      if (m.from === caller.identity) return [];
      return [{ id: m.id, from: m.from, to: m.to, text: m.text, createdAt: m.createdAt }];
    });
    return out;
  });

  router.register("agent.threadStatus", async (input, ctx) => {
    const model = deps.engine.getModel();
    const caller = callerOf(model, ctx);
    const target = model.threads[input.threadId];
    if (!target) throw new RpcException("not-found", notFoundThreadMessage(model, caller.thread, input.threadId));
    const sameSession =
      caller.thread.expertsSessionId !== undefined && target.expertsSessionId === caller.thread.expertsSessionId;
    if (target.delegatedBy !== caller.thread.id && !sameSession) {
      throw new RpcException("forbidden", `thread ${target.id} was not delegated by ${caller.thread.id}`);
    }
    const turn = target.latestTurnId === undefined ? undefined : model.turns[target.latestTurnId];
    const text = lastAssistantText(model, target.id);
    return {
      status: agentStatus(model, target),
      ...(target.attention !== undefined ? { attention: target.attention } : {}),
      ...(text !== undefined ? { lastAssistantText: text } : {}),
      // settled = quiescent: a turn that settled while its background sub-agents work is not done
      settled: isQuiescent(model, target.id),
      ...(turn?.error !== undefined ? { error: turn.error } : {}),
    };
  });
}
