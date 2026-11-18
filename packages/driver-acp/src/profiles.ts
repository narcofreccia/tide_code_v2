import type { AcpConfig, AcpQuirks } from "./types.ts";

/**
 * Known agents that deviate from plain ACP: a launch command plus the quirks that make the
 * generic driver behave. Everything unknown degrades to the generic behaviour.
 */
export interface AcpProfile {
  id: string;
  label: string;
  command: string;
  args: string[];
  quirks: AcpQuirks;
}

/**
 * Google Antigravity (`agy acp`, CLI 1.5.0+), from T3 Code's integration; not verified against a
 * live agent here.
 *  - no `fs.writeTextFile`: with it the agent swaps its diff edits for whole-file client writes
 *  - the agent stays in its own mode (its CLI only accepts default / accept-edits / plan) and
 *    Tide answers permission requests from the runtime mode
 *  - the system prompt rides in `_meta.antigravity.systemPrompt.append`
 *  - reopening uses ACP's resume method
 */
export const ANTIGRAVITY_PROFILE: AcpProfile = {
  id: "antigravity",
  label: "Antigravity",
  command: "agy",
  args: ["acp"],
  quirks: {
    advertiseFsWrite: false,
    keepAgentMode: true,
    systemPromptMeta: ["antigravity", "systemPrompt", "append"],
    resumeMethod: "resume",
  },
};

export const ACP_PROFILES: readonly AcpProfile[] = [ANTIGRAVITY_PROFILE];

const baseName = (command: string): string => (command.split(/[\\/]/).pop() ?? command).replace(/\.(exe|cmd|bat)$/i, "");

/** The profile whose launch command is `command` (`agy`, `/usr/local/bin/agy`, `agy.exe`). */
export function profileForCommand(command: string): AcpProfile | undefined {
  const name = baseName(command);
  return ACP_PROFILES.find((profile) => profile.command === name);
}

/** Explicit `quirks` win; otherwise a known command brings its profile's quirks. */
export function withProfileQuirks(config: AcpConfig): AcpConfig {
  if (config.quirks !== undefined) return config;
  const profile = profileForCommand(config.command);
  return profile ? { ...config, quirks: profile.quirks } : config;
}
