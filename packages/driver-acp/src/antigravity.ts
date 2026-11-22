import type { DriverEnv, ProviderDriver, ProviderInstance } from "@tide/contracts";
import { completeAntigravity } from "./antigravity-complete.ts";
import { AcpInstance } from "./instance.ts";
import { ANTIGRAVITY_INSTALL_COMMAND, ANTIGRAVITY_PROFILE } from "./profiles.ts";
import { nodeSpawn } from "./spawn.ts";
import type { AcpConfig, AcpDeps, AcpFlavor } from "./types.ts";

/**
 * Google Antigravity as a built-in harness: the generic ACP driver launching `agy acp` with the
 * Antigravity profile's quirks, reported under its own kind.
 */
export const ANTIGRAVITY_FLAVOR: AcpFlavor = {
  kind: "antigravity",
  loginCommand: "agy acp --login",
  notInstalledHint: (label, command) => `${label} could not be started (\`${command}\` not found): install it with \`${ANTIGRAVITY_INSTALL_COMMAND}\``,
  minVersion: { major: 1, minor: 5, hint: "Antigravity CLI 1.5 or newer is needed for ACP: run `agy update`" },
  complete: completeAntigravity,
};

/** server.json `providers.antigravity` merged with the instance's settings. */
export interface AntigravityConfig extends Partial<AcpConfig> {
  /** the `agy` binary; replaces `command` */
  binaryPath?: string;
}

export function createAntigravityInstance(config: AntigravityConfig, env: DriverEnv, deps: Partial<AcpDeps> = {}): ProviderInstance {
  const { binaryPath, ...rest } = config;
  const acp: AcpConfig = {
    ...rest,
    command: binaryPath ?? rest.command ?? ANTIGRAVITY_PROFILE.command,
    args: rest.args ?? ANTIGRAVITY_PROFILE.args,
    // stated, not matched on the command's name: a renamed binary keeps them
    quirks: rest.quirks ?? ANTIGRAVITY_PROFILE.quirks,
    label: rest.label ?? env.instance?.label ?? ANTIGRAVITY_PROFILE.label,
  };
  return new AcpInstance(acp, env, { ...deps, spawn: deps.spawn ?? nodeSpawn }, ANTIGRAVITY_FLAVOR);
}

export const antigravityDriver: ProviderDriver<AntigravityConfig> = {
  kind: "antigravity",
  defaultConfig(): AntigravityConfig {
    return { command: ANTIGRAVITY_PROFILE.command, args: [...ANTIGRAVITY_PROFILE.args], quirks: { ...ANTIGRAVITY_PROFILE.quirks } };
  },
  async create(config: AntigravityConfig, env: DriverEnv): Promise<ProviderInstance> {
    return createAntigravityInstance(config, env);
  },
};
