import type { CommandOf, DomainEvent, ExpertsFinding, ExpertsMessage, Project, ProposedPlan, ReadModel, RuntimeMode, Thread } from "@tide/contracts";
import { delegatePrompt } from "../../experts/prompts.ts";
import { recipientKeys } from "./experts.ts";
import { fail, isArchived, ok, turnRequested, type DecideContext, type DecideResult } from "./types.ts";

type AgentCommand =
  | CommandOf<"experts.finding.post">
  | CommandOf<"experts.message.send">
  | CommandOf<"experts.synthesis.set">
  | CommandOf<"thread.delegate">;

/**
 * Commands an agent issues through the Tide MCP server. Identity (author / from /
 * fromThreadId) is stamped by the RPC layer from the authenticated thread — the decider
 * only checks that the identity exists on the session it claims.
 */
export function decideAgent(model: ReadModel, command: AgentCommand, ctx: DecideContext): DecideResult {
  switch (command.type) {
    case "experts.finding.post": {
      const session = model.expertsSessions[command.sessionId];
      if (!session) return fail("not-found", `unknown experts session ${command.sessionId}`);
      if (session.phase === "archived") return fail("conflict", `experts session ${session.id} is archived`);
      if (command.author !== "user" && !recipientKeys(session).includes(command.author)) {
        return fail("forbidden", `${command.author} is not on experts session ${session.id}`);
      }
      const finding: ExpertsFinding = {
        id: ctx.newId(),
        sessionId: session.id,
        author: command.author,
        text: command.text,
        createdAt: ctx.now,
      };
      return ok({ type: "experts.finding-posted", finding });
    }

    case "experts.message.send": {
      const session = model.expertsSessions[command.sessionId];
      if (!session) return fail("not-found", `unknown experts session ${command.sessionId}`);
      if (session.phase === "archived") return fail("conflict", `experts session ${session.id} is archived`);
      const keys = recipientKeys(session);
      if (command.from !== "user" && !keys.includes(command.from)) {
        return fail("forbidden", `${command.from} is not on experts session ${session.id}`);
      }
      if (command.to !== "all" && command.to !== "user" && !keys.includes(command.to)) {
        return fail("not-found", `unknown recipient ${command.to}`);
      }
      const message: ExpertsMessage = {
        id: ctx.newId(),
        sessionId: session.id,
        from: command.from,
        to: command.to,
        text: command.text,
        createdAt: ctx.now,
      };
      return ok({ type: "experts.message-posted", message });
    }

    case "experts.synthesis.set": {
      const session = model.expertsSessions[command.sessionId];
      if (!session) return fail("not-found", `unknown experts session ${command.sessionId}`);
      // a synthesis lands while the lead is synthesizing (or, early, while the panel discusses);
      // never before the panel has explored, never over a finished one
      if (session.phase !== "synthesizing" && session.phase !== "discussing") {
        return fail("conflict", `experts session ${session.id} is ${session.phase}; a synthesis needs phase synthesizing or discussing`);
      }
      const leadThreadId = session.lead.threadId;
      const lead = leadThreadId === undefined ? undefined : model.threads[leadThreadId];
      if (!lead) return fail("conflict", `experts session ${session.id} has no lead thread`);
      const turnId = lead.latestTurnId;
      if (turnId === undefined) return fail("conflict", `lead thread ${lead.id} has no turn`);
      // The synthesis lands as an ordinary ProposedPlan so the existing
      // "Implement in a new thread" flow applies unchanged.
      const plan: ProposedPlan = {
        id: ctx.newId(),
        threadId: lead.id,
        turnId,
        markdown: command.markdown,
        status: "proposed",
        createdAt: ctx.now,
        updatedAt: ctx.now,
      };
      return ok(
        { type: "experts.synthesis-set", sessionId: session.id, markdown: command.markdown, planId: plan.id, at: ctx.now },
        { type: "plan.proposed", plan },
      );
    }

    case "thread.delegate": {
      const from = model.threads[command.fromThreadId];
      if (!from) return fail("not-found", `unknown thread ${command.fromThreadId}`);
      if (isArchived(from)) return fail("conflict", `thread ${from.id} is archived`);
      if (delegationDepth(model, from) + 1 > MAX_DELEGATION_DEPTH) {
        return fail("forbidden", `delegation depth limit (${MAX_DELEGATION_DEPTH}) reached: a delegate of a delegate cannot delegate further`);
      }
      const live = Object.values(model.threads).filter((t) => t.delegatedBy === from.id && !isArchived(t) && t.status === "running").length;
      if (live >= MAX_LIVE_DELEGATES) return fail("busy", `thread ${from.id} already has ${live} running delegates (limit ${MAX_LIVE_DELEGATES})`);
      const home = model.projects[from.projectId];
      if (!home) return fail("not-found", `unknown project ${from.projectId}`);
      if (isArchived(home)) return fail("conflict", `project ${home.id} is archived`);

      // `repo` names one of the caller's links: the delegate runs with that repo as its
      // *main* repo (its own project), not as a link. It carries no links of its own.
      let project = home;
      const extra: DomainEvent[] = [];
      if (command.repo !== undefined) {
        const wanted = command.repo.trim().toLowerCase();
        const link = (home.links ?? []).find((l) => l.label.trim().toLowerCase() === wanted);
        if (!link) return fail("not-found", `no linked repository labelled ${command.repo} on project ${home.id}`);
        // a read-only link must not be laundered into a full-write main project
        if (link.access === "read") {
          return fail("invalid-command", `link ${link.label} is read-only; delegate cannot run with it as its main repo`);
        }
        const existing = Object.values(model.projects).find((p) => !isArchived(p) && p.rootPath === link.path);
        if (existing) project = existing;
        else {
          project = { id: ctx.newId(), title: link.label, rootPath: link.path, createdAt: ctx.now, updatedAt: ctx.now } satisfies Project;
          extra.push({ type: "project.created", project });
        }
      }
      const thread: Thread = {
        id: ctx.newId(),
        projectId: project.id,
        parentThreadId: from.id,
        title: command.title ?? `Delegated by ${from.title}`,
        provider: command.provider,
        ...(command.model !== undefined ? { model: command.model } : {}),
        mode: clampMode(command.mode, from.mode),
        interaction: "default",
        role: "delegate",
        delegatedBy: from.id,
        status: "idle",
        createdAt: ctx.now,
        updatedAt: ctx.now,
      };
      return ok(
        ...extra,
        { type: "thread.created", thread, ...(command.useWorktree !== undefined ? { useWorktree: command.useWorktree } : {}) },
        turnRequested(thread.id, delegatePrompt(command.prompt, from.title), ctx),
      );
    }
  }
}

/** root → delegate → delegate-of-delegate; one more hop is refused (runaway recursion guard). */
export const MAX_DELEGATION_DEPTH = 2;
/** running delegates one thread may have at once (fan-out guard) */
export const MAX_LIVE_DELEGATES = 4;

/** Hops from `thread` back to a thread that was not delegated (cycle-safe). */
export function delegationDepth(model: ReadModel, thread: Thread): number {
  let depth = 0;
  const seen = new Set<string>([thread.id]);
  let current = thread.delegatedBy === undefined ? undefined : model.threads[thread.delegatedBy];
  while (current !== undefined && !seen.has(current.id)) {
    depth++;
    seen.add(current.id);
    current = current.delegatedBy === undefined ? undefined : model.threads[current.delegatedBy];
  }
  // a delegate whose parent is gone still counts its own hop
  return thread.delegatedBy !== undefined && depth === 0 ? 1 : depth;
}

/**
 * A delegate may never be more privileged than the thread that spawned it: an
 * `approval-required` parent cannot hand out `full-access`. With no mode requested the child
 * simply inherits the parent's.
 */
const MODE_RANK: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

export function clampMode(requested: RuntimeMode | undefined, parent: RuntimeMode): RuntimeMode {
  if (requested === undefined) return parent;
  return MODE_RANK[requested] > MODE_RANK[parent] ? parent : requested;
}
