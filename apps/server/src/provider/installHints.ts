import type { ProviderKind } from "@tide/contracts";
import type { AcpAgentEntry } from "./acpRegistry.ts";

/**
 * How to get one harness onto this machine: the shell command and/or the page that explains it.
 * One source for `tide doctor` and the `providers.list` answer, so the CLI and the app never
 * give two different instructions.
 */
export interface InstallHint {
  command?: string;
  url?: string;
}

export interface HarnessInstall {
  /** the executable `tide doctor` looks for on PATH */
  bin: string;
  label: string;
  command: string;
  url: string;
}

/** The four bundled harnesses. The npm packages match the updaters in `rpc/env.ts`. */
export const HARNESS_INSTALLS: Record<Exclude<ProviderKind, "acp">, HarnessInstall> = {
  claude: { bin: "claude", label: "Claude Code", command: "npm i -g @anthropic-ai/claude-code", url: "https://claude.com/claude-code" },
  codex: { bin: "codex", label: "Codex", command: "npm i -g @openai/codex", url: "https://github.com/openai/codex" },
  opencode: { bin: "opencode", label: "OpenCode", command: "npm i -g @opencode/cli", url: "https://opencode.ai" },
  pi: {
    bin: "pi",
    label: "Pi",
    command: "npm i -g @earendil-works/pi-coding-agent",
    url: "https://www.npmjs.com/package/@earendil-works/pi-coding-agent",
  },
};

/**
 * An ACP agent from the registry: Tide launches npx/uvx agents itself, so there is no command to
 * give, only the agent's own page (website, else repository). A manual-command agent has none.
 */
export function acpInstallHint(agent: AcpAgentEntry | undefined): InstallHint | undefined {
  const url = agent?.website ?? agent?.repository;
  return url === undefined ? undefined : { url };
}

/** The hint for a bundled kind; ACP agents go through `acpInstallHint`. */
export function installHintFor(kind: ProviderKind): InstallHint | undefined {
  if (kind === "acp") return undefined;
  const h = HARNESS_INSTALLS[kind];
  return { command: h.command, url: h.url };
}
