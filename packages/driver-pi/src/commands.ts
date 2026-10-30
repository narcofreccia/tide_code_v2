import type { DriverEnv, ModelInfo, SlashCommandInfo } from "@tide/contracts";
import { CONFIG_COMMAND } from "@tide/pi-extensions/protocol";
import { PiRpc } from "./rpc.ts";
import type { PiCommandInfo, PiConfig, PiDeps } from "./types.ts";

/**
 * `get_commands` rows -> the composer's picker. Extension and prompt-template commands are
 * "custom", skills ("skill:" prefix) are "skill". Tide's own `/tide-config` (tide-bridge) is hidden.
 * Executing one is just sending `/name args` as the prompt, which pi resolves itself.
 */
export function toSlashCommands(commands: PiCommandInfo[]): SlashCommandInfo[] {
  return commands
    .filter((command) => typeof command.name === "string" && command.name !== "" && command.name !== CONFIG_COMMAND)
    .map((command) => ({
      name: command.name,
      ...(command.description ? { description: command.description } : {}),
      source: command.source === "skill" || command.name.startsWith("skill:") ? ("skill" as const) : ("custom" as const),
    }));
}

/** A short-lived `pi --mode rpc --no-session` rooted at `cwd`, so project prompts/skills are included. */
export async function listCommands(binary: string, cwd: string, config: PiConfig, deps: PiDeps, env: DriverEnv): Promise<SlashCommandInfo[]> {
  const child = deps.spawn(binary, ["--mode", "rpc", "--no-session"], { cwd, env: { ...process.env, ...config.env } });
  const rpc = new PiRpc(child, { onLine: () => undefined, log: (message) => env.log(message) });
  try {
    const data = await rpc.data<{ commands?: PiCommandInfo[] }>({ type: "get_commands" });
    return toSlashCommands(data?.commands ?? []);
  } catch (error) {
    env.log(`[pi] get_commands failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  } finally {
    rpc.close();
  }
}

/** Thinking levels (`get_available_thinking_levels`) as efforts for the models that can reason. */
export function withEfforts(models: ModelInfo[], reasoning: Set<string>, levels: string[]): ModelInfo[] {
  if (levels.length === 0) return models;
  return models.map((model) => (reasoning.has(model.id) ? { ...model, efforts: levels.map((id) => ({ id, label: id })) } : model));
}
