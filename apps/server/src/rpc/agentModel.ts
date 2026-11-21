import type { AgentCommand, AgentHarness, ProviderStatusDto, UserSettings } from "@tide/contracts";
import { userDefaultModel } from "../provider/delegateTargets.ts";
import { modelNote, resolveModel } from "../provider/modelResolve.ts";

/** The registry slice the agent methods read: status per instance (cached by the registry). */
export interface AgentRegistryView {
  status(id: string): Promise<ProviderStatusDto>;
  statusAll(refresh?: boolean): Promise<ProviderStatusDto[]>;
}

/**
 * R23: checks the model id an agent passed for a delegate or a new-thread automation against the
 * target harness's own list. A display-name spelling that names exactly one listed model is
 * rewritten to its id; anything else passes through (lists are partial: Claude Code runs ids it
 * does not list, Codex hides models). The note says what happened, and also when the harness
 * last reported itself not installed or not signed in. Nothing is refused here.
 */
export async function resolveCommandModel(command: AgentCommand, registry: AgentRegistryView): Promise<{ command: AgentCommand; modelNote?: string }> {
  const target = modelTarget(command);
  if (target === undefined) return { command };
  let status: ProviderStatusDto;
  try {
    status = await registry.status(target.instanceId);
  } catch {
    return { command };
  }
  const resolution = resolveModel(target.model, status.models);
  const notes: string[] = [];
  const said = modelNote(resolution, target.instanceId, status.models);
  if (said !== undefined) notes.push(said);
  const state = !status.installed ? "not installed" : !status.loggedIn ? "not signed in" : undefined;
  if (state !== undefined) notes.push(`${target.instanceId} was ${state} at its last status check; a thread on it may fail to start`);
  const rewritten = resolution.kind === "resolved" ? withModel(command, resolution.model) : command;
  return { command: rewritten, ...(notes.length > 0 ? { modelNote: notes.join("; ") } : {}) };
}

function modelTarget(command: AgentCommand): { instanceId: string; model: string } | undefined {
  if (command.type === "thread.delegate" && command.model !== undefined && command.model !== "") {
    return { instanceId: command.providerId ?? command.provider, model: command.model };
  }
  if (command.type === "task.create" && command.model !== undefined && command.model !== "" && command.provider !== undefined) {
    return { instanceId: command.provider, model: command.model };
  }
  return undefined;
}

function withModel(command: AgentCommand, model: string): AgentCommand {
  return command.type === "thread.delegate" || command.type === "task.create" ? { ...command, model } : command;
}

/** One status DTO as `agent.harnesses` reports it; `defaultModel` = user setting, else the harness's own default. */
export function toAgentHarness(dto: ProviderStatusDto, defaults: UserSettings["providerDefaults"]): AgentHarness {
  const defaultModel = userDefaultModel(defaults, dto.id, dto.kind) ?? dto.models.find((m) => m.default === true)?.id;
  return {
    provider: dto.kind,
    providerId: dto.id,
    label: dto.label,
    installed: dto.installed,
    loggedIn: dto.loggedIn,
    ...(defaultModel !== undefined ? { defaultModel } : {}),
    models: dto.models.map((m) => ({ id: m.id, label: m.label })),
  };
}
