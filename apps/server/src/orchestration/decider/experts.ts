import type {
  CommandOf,
  DomainEvent,
  ExpertsFinding,
  ExpertsMessage,
  ExpertsPhase,
  ExpertsSession,
  ExpertState,
  ReadModel,
  Thread,
} from "@tide/contracts";
import { discussionPrompt, explorationPrompt, synthesisPrompt } from "../../experts/prompts.ts";
import { fail, isArchived, lacksTideMcp, NO_TIDE_MCP_MESSAGE, ok, turnRequested, type DecideContext, type DecideResult } from "./types.ts";

type ExpertsCommand =
  | CommandOf<"experts.create">
  | CommandOf<"experts.start">
  | CommandOf<"experts.post">
  | CommandOf<"experts.set-phase">
  | CommandOf<"experts.archive">
  | CommandOf<"experts.threads.bound">
  | CommandOf<"experts.expert.status">;

/** Everyone who can author on the board. */
export function recipientKeys(session: ExpertsSession): string[] {
  return [...session.experts.map((e) => e.key), "lead"];
}

export function sessionFindings(model: ReadModel, session: ExpertsSession): ExpertsFinding[] {
  return session.findingIds.flatMap((id) => (model.expertsFindings[id] ? [model.expertsFindings[id]] : []));
}

export function sessionMessages(model: ReadModel, session: ExpertsSession): ExpertsMessage[] {
  return session.messageIds.flatMap((id) => (model.expertsMessages[id] ? [model.expertsMessages[id]] : []));
}

/** A turn can only be queued on a thread that exists and is not mid-turn. */
function readyThread(model: ReadModel, threadId: string | undefined): Thread | undefined {
  const thread = threadId === undefined ? undefined : model.threads[threadId];
  if (!thread || isArchived(thread) || thread.status === "running") return undefined;
  return thread;
}

export function decideExperts(model: ReadModel, command: ExpertsCommand, ctx: DecideContext): DecideResult {
  switch (command.type) {
    case "experts.create": {
      const project = model.projects[command.projectId];
      if (!project) return fail("not-found", `unknown project ${command.projectId}`);
      if (isArchived(project)) return fail("conflict", `project ${project.id} is archived`);
      const keys = new Set<string>();
      for (const spec of command.experts) {
        if (spec.key === "lead" || spec.key === "user" || spec.key === "all") {
          return fail("invalid-command", `expert key ${spec.key} is reserved`);
        }
        if (keys.has(spec.key)) return fail("invalid-command", `duplicate expert key ${spec.key}`);
        keys.add(spec.key);
        // the whole panel talks through the Tide MCP board; a harness without it never reports back
        if (lacksTideMcp(spec.provider)) return fail("invalid-command", NO_TIDE_MCP_MESSAGE);
      }
      if (lacksTideMcp(command.lead.provider)) return fail("invalid-command", NO_TIDE_MCP_MESSAGE);
      const session: ExpertsSession = {
        id: ctx.newId(),
        projectId: project.id,
        topic: command.topic,
        phase: "setup",
        experts: command.experts.map((spec) => ({ ...spec, status: "pending" })),
        lead: { provider: command.lead.provider, ...(command.lead.model !== undefined ? { model: command.lead.model } : {}) },
        findingIds: [],
        messageIds: [],
        createdAt: ctx.now,
        updatedAt: ctx.now,
      };
      return ok({ type: "experts.created", session });
    }

    case "experts.start": {
      const session = model.expertsSessions[command.sessionId];
      if (!session) return fail("not-found", `unknown experts session ${command.sessionId}`);
      if (session.phase !== "setup") return fail("conflict", `experts session ${session.id} is already ${session.phase}`);
      const project = model.projects[session.projectId];
      if (!project) return fail("not-found", `unknown project ${session.projectId}`);
      if (isArchived(project)) return fail("conflict", `project ${project.id} is archived`);

      const events: DomainEvent[] = [];
      const bindings: { key: string; threadId: string }[] = [];
      const bound: ExpertState[] = [];
      for (const expert of session.experts) {
        // Experts are read-mostly (they read/grep and post findings), so they run
        // unattended in `auto` — an approval prompt would stall the whole panel.
        const thread: Thread = {
          id: ctx.newId(),
          projectId: project.id,
          title: `${expert.name} (${expert.role})`,
          provider: expert.provider,
          ...(expert.model !== undefined ? { model: expert.model } : {}),
          mode: "auto",
          interaction: "default",
          role: "expert",
          expertsSessionId: session.id,
          status: "idle",
          createdAt: ctx.now,
          updatedAt: ctx.now,
        };
        events.push({ type: "thread.created", thread });
        bindings.push({ key: expert.key, threadId: thread.id });
        bound.push({ ...expert, threadId: thread.id });
      }
      const leadThread: Thread = {
        id: ctx.newId(),
        projectId: project.id,
        title: `Lead — ${session.topic}`,
        provider: session.lead.provider,
        ...(session.lead.model !== undefined ? { model: session.lead.model } : {}),
        mode: "auto",
        interaction: "default",
        role: "lead",
        expertsSessionId: session.id,
        status: "idle",
        createdAt: ctx.now,
        updatedAt: ctx.now,
      };
      events.push({ type: "thread.created", thread: leadThread });
      events.push({ type: "experts.threads-bound", sessionId: session.id, bindings, leadThreadId: leadThread.id, at: ctx.now });
      events.push({ type: "experts.phase-changed", sessionId: session.id, phase: "exploring", at: ctx.now });

      const started: ExpertsSession = { ...session, experts: bound };
      for (const expert of bound) {
        if (expert.threadId === undefined) continue;
        events.push(turnRequested(expert.threadId, explorationPrompt(started, expert), ctx));
        events.push({ type: "experts.expert-status-changed", sessionId: session.id, key: expert.key, status: "working", at: ctx.now });
      }
      return ok(...events);
    }

    case "experts.post": {
      const session = model.expertsSessions[command.sessionId];
      if (!session) return fail("not-found", `unknown experts session ${command.sessionId}`);
      if (session.phase === "archived") return fail("conflict", `experts session ${session.id} is archived`);
      const to = command.to ?? "all";
      if (to !== "all" && !recipientKeys(session).includes(to)) return fail("not-found", `unknown recipient ${to}`);
      const message: ExpertsMessage = {
        id: ctx.newId(),
        sessionId: session.id,
        from: "user",
        to,
        text: command.text,
        createdAt: ctx.now,
      };
      return ok({ type: "experts.message-posted", message });
    }

    case "experts.set-phase":
      return setPhase(model, command.sessionId, command.phase, ctx);

    case "experts.archive": {
      const session = model.expertsSessions[command.sessionId];
      if (!session) return fail("not-found", `unknown experts session ${command.sessionId}`);
      if (session.phase === "archived") return ok(); // idempotent
      return ok({ type: "experts.archived", sessionId: session.id, at: ctx.now });
    }

    case "experts.threads.bound": {
      const session = model.expertsSessions[command.sessionId];
      if (!session) return fail("not-found", `unknown experts session ${command.sessionId}`);
      return ok({
        type: "experts.threads-bound",
        sessionId: session.id,
        bindings: command.bindings,
        leadThreadId: command.leadThreadId,
        at: ctx.now,
      });
    }

    case "experts.expert.status": {
      const session = model.expertsSessions[command.sessionId];
      if (!session) return fail("not-found", `unknown experts session ${command.sessionId}`);
      const expert = session.experts.find((e) => e.key === command.key);
      if (!expert) return fail("not-found", `unknown expert ${command.key}`);
      if (expert.status === command.status) return ok(); // idempotent
      return ok({ type: "experts.expert-status-changed", sessionId: session.id, key: expert.key, status: command.status, at: ctx.now });
    }
  }
}

const ALLOWED: Partial<Record<ExpertsPhase, ExpertsPhase[]>> = {
  exploring: ["discussing"],
  discussing: ["synthesizing"],
};

function setPhase(model: ReadModel, sessionId: string, phase: ExpertsPhase, ctx: DecideContext): DecideResult {
  const session = model.expertsSessions[sessionId];
  if (!session) return fail("not-found", `unknown experts session ${sessionId}`);
  if (session.phase === "archived") return fail("conflict", `experts session ${session.id} is archived`);
  if (phase === "archived") return ok({ type: "experts.phase-changed", sessionId: session.id, phase, at: ctx.now });
  if (session.phase === phase) return ok(); // idempotent
  if (!(ALLOWED[session.phase] ?? []).includes(phase)) {
    return fail("conflict", `cannot move experts session ${session.id} from ${session.phase} to ${phase}`);
  }

  const events: DomainEvent[] = [{ type: "experts.phase-changed", sessionId: session.id, phase, at: ctx.now }];
  if (phase === "discussing") {
    const findings = sessionFindings(model, session);
    for (const expert of session.experts) {
      // A busy expert is skipped rather than queued: its running turn already sees
      // the board through the MCP tools, and the panel must not block on it.
      const thread = readyThread(model, expert.threadId);
      if (!thread) continue;
      events.push(turnRequested(thread.id, discussionPrompt(session, expert, findings), ctx));
      events.push({ type: "experts.expert-status-changed", sessionId: session.id, key: expert.key, status: "working", at: ctx.now });
    }
  }
  if (phase === "synthesizing") {
    const lead = readyThread(model, session.lead.threadId);
    if (!lead) return fail("busy", `lead thread of ${session.id} is not ready`);
    events.push(turnRequested(lead.id, synthesisPrompt(session, sessionFindings(model, session), sessionMessages(model, session)), ctx));
  }
  return ok(...events);
}
