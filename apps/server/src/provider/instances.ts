import { homedir } from "node:os";
import { join } from "node:path";
import type { DriverEnv, ProviderDriver, ProviderInstanceConfig, ProviderKind } from "@tide/contracts";
import type { ProviderConfigs } from "../config.ts";
import { platformKey, resolveLaunch, type AcpLaunch, type AcpRegistry } from "./acpRegistry.ts";
import type { InstanceFactory, InstanceSpec } from "./registry.ts";

type AnyDriver = ProviderDriver<Record<string, unknown>>;

export interface FactoryDeps {
  /** server.json `providers.<kind>`: the base every instance of that kind starts from */
  providers: ProviderConfigs;
  acp: Pick<AcpRegistry, "find">;
  /** one driver per kind (load.ts passes the bundled ones; tests pass fakes) */
  drivers: Partial<Record<ProviderKind, AnyDriver>>;
  platform?: string;
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** Where each harness reads its account from: one directory per instance is one account. */
function homeEnv(kind: ProviderKind, home: string): Record<string, string> {
  switch (kind) {
    case "claude":
      return { CLAUDE_CONFIG_DIR: home };
    case "codex":
      return { CODEX_HOME: home };
    default:
      return { HOME: home };
  }
}

function envOf(value: unknown): Record<string, string> {
  return typeof value === "object" && value !== null ? (value as Record<string, string>) : {};
}

/**
 * Settings instance → registry spec. Bundled kinds reuse their driver with the server.json
 * config, the instance's binary/env on top and `home` mapped to the harness's own variable
 * (CLAUDE_CONFIG_DIR, CODEX_HOME, HOME). ACP instances run `acpDriver` with a manual command
 * or the registry agent's npx/uvx launch.
 */
export function createInstanceFactory(deps: FactoryDeps): InstanceFactory {
  return (config: ProviderInstanceConfig, env: DriverEnv): InstanceSpec => {
    const home = config.home !== undefined ? expandHome(config.home) : undefined;
    if (config.kind === "acp") return acpSpec(config, env, home, deps);
    const driver = deps.drivers[config.kind];
    if (!driver) throw new Error(`no ${config.kind} driver in this build`);
    const base = deps.providers[config.kind] ?? {};
    const mergedEnv = { ...envOf(base["env"]), ...(home !== undefined ? homeEnv(config.kind, home) : {}), ...config.env };
    const driverConfig: Record<string, unknown> = {
      ...driver.defaultConfig(),
      ...base,
      ...(config.binaryPath !== undefined ? { binaryPath: config.binaryPath } : {}),
      ...(config.kind === "codex" && home !== undefined ? { codexHome: home } : {}),
      env: mergedEnv,
    };
    const instanceEnv: DriverEnv = { ...env, instance: { id: config.id, label: config.label, ...(home !== undefined ? { home } : {}), env: mergedEnv } };
    return {
      id: config.id,
      kind: config.kind,
      label: config.label,
      open: () => driver.create(driverConfig, instanceEnv),
      fingerprint: JSON.stringify(config),
    };
  };
}

function acpSpec(config: ProviderInstanceConfig, env: DriverEnv, home: string | undefined, deps: FactoryDeps): InstanceSpec {
  const driver = deps.drivers.acp;
  if (!driver) throw new Error("no ACP driver in this build");
  let launch: AcpLaunch;
  if (config.command !== undefined) {
    launch = { command: config.command, args: config.args ?? [], env: {} };
  } else {
    const agentId = config.acpAgentId ?? "";
    const agent = deps.acp.find(agentId);
    if (!agent) throw new Error(`ACP agent ${agentId} is not in the registry; refresh it or configure a command`);
    const resolved = resolveLaunch(agent, deps.platform ?? platformKey());
    if (!resolved) throw new Error(`${agent.name} ships only as a prebuilt binary for this platform; install it and configure its command instead`);
    launch = { command: resolved.command, args: [...resolved.args, ...(config.args ?? [])], env: resolved.env };
  }
  const mergedEnv = { ...launch.env, ...config.env };
  const driverConfig: Record<string, unknown> = {
    ...driver.defaultConfig(),
    command: config.binaryPath ?? launch.command,
    args: launch.args,
    env: mergedEnv,
    ...(home !== undefined ? { home } : {}),
    label: config.label,
  };
  const instanceEnv: DriverEnv = { ...env, instance: { id: config.id, label: config.label, ...(home !== undefined ? { home } : {}), env: mergedEnv } };
  return {
    id: config.id,
    kind: "acp",
    label: config.label,
    open: () => driver.create(driverConfig, instanceEnv),
    fingerprint: JSON.stringify({ config, launch }),
  };
}
