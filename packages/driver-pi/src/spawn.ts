import type { OpenSessionOptions } from "@tide/contracts";
import { ENV_CWD, ENV_INTERACTION, ENV_LINKED_DIRS, ENV_MCP_SERVERS, ENV_RUNTIME_MODE, ENV_SYSTEM_PROMPT_APPEND, ENV_THREAD_ID } from "@tide/pi-extensions/protocol";
import type { PiConfig } from "./types.ts";

/**
 * Argument vector + environment for one `pi --mode rpc` process.
 *
 * Never passes `--no-extensions` (it also disables pi's built-ins, MCP included, since 0.99),
 * `--no-mcp`, `--no-skills` or `--tools`: the user's extensions, skills, prompt templates and
 * MCP servers stay on (CLAUDE.md §1a). Tide only ADDS tide-bridge, and through it its MCP
 * server(s) (`TIDE_MCP_SERVERS` → `pi.registerMcpServer()`).
 */
export function buildSpawn(
  options: OpenSessionOptions,
  config: PiConfig,
  bridgePath: string | undefined,
): { args: string[]; env: NodeJS.ProcessEnv } {
  const args = ["--mode", "rpc"];
  if (bridgePath) args.push("-e", bridgePath);
  for (const extension of config.extraExtensions ?? []) args.push("-e", extension);
  if (options.resume) args.push("--session", options.resume);
  const model = options.model ?? config.defaultModel;
  if (model) args.push("--model", model);
  const mcpServers = options.mcpServers.map((server) => ({
    name: server.name,
    command: server.command,
    ...(server.args ? { args: server.args } : {}),
    ...(server.env ? { env: server.env } : {}),
  }));
  return {
    args,
    env: {
      ...process.env,
      ...config.env,
      ...options.env,
      [ENV_RUNTIME_MODE]: options.mode,
      [ENV_INTERACTION]: options.interaction,
      [ENV_THREAD_ID]: options.threadId,
      [ENV_CWD]: options.cwd,
      ...(options.linkedDirs && options.linkedDirs.length > 0 ? { [ENV_LINKED_DIRS]: JSON.stringify(options.linkedDirs) } : {}),
      ...(options.systemPromptAppend !== undefined ? { [ENV_SYSTEM_PROMPT_APPEND]: options.systemPromptAppend } : {}),
      ...(mcpServers.length > 0 ? { [ENV_MCP_SERVERS]: JSON.stringify(mcpServers) } : {}),
    },
  };
}

/** `provider/id` → `set_model` params; undefined for a bare id or a pattern pi must resolve. */
export function splitModelId(model: string): { provider: string; modelId: string } | undefined {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1 || /[*?]/.test(model)) return undefined;
  return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}
