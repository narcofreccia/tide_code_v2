import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { McpServerSpec } from "@tide/contracts";
import type { AgentTokenStore } from "../rpc/agentTickets.ts";

export interface McpEntry {
  command: string;
  args: string[];
}

/** `packages/tide-mcp/src/bin.ts` as seen from `apps/server/src/mcp/`. */
function devEntryPath(): string {
  return resolve(import.meta.dirname, "..", "..", "..", "..", "packages", "tide-mcp", "src", "bin.ts");
}

/**
 * Dev runs the TypeScript entry straight off disk with node's type stripping. The
 * bun-compiled sidecar has no `packages/` next to it, so it re-execs itself with
 * `--mcp`, which boots the same MCP server in-process — one binary, no extra runtime.
 */
export function resolveMcpEntry(entryPath: string = devEntryPath()): McpEntry {
  if (existsSync(entryPath)) {
    return {
      command: process.execPath,
      args: ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", entryPath],
    };
  }
  return { command: process.execPath, args: ["--mcp"] };
}

export interface McpProvisionerOptions {
  tokens: AgentTokenStore;
  entry?: McpEntry;
  /** ws url of this server; until it is known no MCP server is attached */
  url?: string;
}

/**
 * Builds the `tide` MCP server spec handed to every provider session: the same binary
 * for all harnesses, parameterised by the thread's own agent token. Drivers without MCP
 * support simply ignore it.
 */
export class TideMcpProvisioner {
  #tokens: AgentTokenStore;
  #entry: McpEntry;
  #url: string | undefined;

  constructor(options: McpProvisionerOptions) {
    this.#tokens = options.tokens;
    this.#entry = options.entry ?? resolveMcpEntry();
    this.#url = options.url;
  }

  setUrl(url: string): void {
    this.#url = url;
  }

  get url(): string | undefined {
    return this.#url;
  }

  serversFor(threadId: string): McpServerSpec[] {
    if (this.#url === undefined) return [];
    return [
      {
        name: "tide",
        command: this.#entry.command,
        args: this.#entry.args,
        env: {
          TIDE_SERVER_URL: this.#url,
          TIDE_AGENT_TOKEN: this.#tokens.getOrCreate(threadId),
          TIDE_THREAD_ID: threadId,
        },
      },
    ];
  }

  revoke(threadId: string): void {
    this.#tokens.revoke(threadId);
  }
}
