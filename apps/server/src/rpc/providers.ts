import type { SlashCommandInfo } from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import { AcpRegistry, toRegistryDto } from "../provider/acpRegistry.ts";
import { CommandsCache } from "../provider/commands.ts";
import type { DriverRegistry } from "../provider/registry.ts";
import { instanceIdOf, threadCwd } from "../provider/sessions.ts";
import type { SettingsStore } from "../settings.ts";
import { RpcException, type RpcRouter } from "./router.ts";

export interface ProviderHandlerDeps {
  engine: Engine;
  registry: DriverRegistry;
  /** shared with the reactor, which feeds it the lists live sessions announce */
  commands?: CommandsCache;
  acp?: AcpRegistry;
  settings?: SettingsStore;
  dataDir?: string;
  log?: (msg: string, data?: unknown) => void;
}

/** `providers.*`: instance status, the `/` picker's commands, the ACP agent catalogue. */
export function registerProviderHandlers(router: RpcRouter, deps: ProviderHandlerDeps): void {
  const log = deps.log ?? (() => undefined);
  const commands = deps.commands ?? new CommandsCache();
  const acp = deps.acp ?? new AcpRegistry({ dataDir: deps.dataDir ?? ":memory:", log });

  router.register("providers.list", async (input) => deps.registry.statusAll(input.refresh ?? false));

  router.register("providers.commands", async (input) => ({ commands: await threadCommands(deps, commands, input.threadId, log) }));

  router.register("providers.acpRegistry", async (input) => {
    const agents = await acp.load(input.refresh ?? false);
    const configured = new Set(
      (deps.settings?.get().providerInstances ?? []).flatMap((p) => (p.kind === "acp" && p.acpAgentId !== undefined ? [p.acpAgentId] : [])),
    );
    return {
      agents: agents.map((a) => toRegistryDto(a, configured)),
      ...(acp.fetchedAt !== undefined ? { fetchedAt: acp.fetchedAt } : {}),
    };
  });
}

async function threadCommands(deps: ProviderHandlerDeps, cache: CommandsCache, threadId: string, log: (msg: string, data?: unknown) => void): Promise<SlashCommandInfo[]> {
  const model = deps.engine.getModel();
  const thread = model.threads[threadId];
  if (!thread) throw new RpcException("not-found", `unknown thread ${threadId}`);
  const project = model.projects[thread.projectId];
  if (!project) throw new RpcException("not-found", `unknown project ${thread.projectId}`);
  const providerId = instanceIdOf(thread);
  const cwd = threadCwd(thread, project);
  const cached = cache.get(providerId, cwd);
  if (cached) return cached;
  if (!deps.registry.has(providerId)) return [];
  try {
    const instance = await deps.registry.get(providerId);
    if (!instance.listCommands) return [];
    const list = await instance.listCommands({ cwd });
    cache.put(providerId, cwd, list);
    return list;
  } catch (err) {
    // the picker degrades to free typing; slash commands still pass through to the harness
    log(`[provider] listCommands(${providerId}) failed`, err instanceof Error ? err.message : err);
    return [];
  }
}
