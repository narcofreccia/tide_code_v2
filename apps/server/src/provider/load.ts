import type { ProviderDriver, ProviderKind } from "@tide/contracts";
import { acpDriver } from "@tide/driver-acp";
import { claudeDriver } from "@tide/driver-claude";
import { codexDriver } from "@tide/driver-codex";
import { opencodeDriver } from "@tide/driver-opencode";
import { piDriver } from "@tide/driver-pi";
import type { ProviderConfigs } from "../config.ts";
import type { AcpRegistry } from "./acpRegistry.ts";
import { createInstanceFactory } from "./instances.ts";
import type { DriverRegistry, InstanceFactory } from "./registry.ts";

type AnyDriver = ProviderDriver<Record<string, unknown>>;
type Log = (msg: string, data?: unknown) => void;

/**
 * Driver packages are workspace dependencies and are imported statically so the
 * bun-compiled sidecar bundles them (a runtime `import(<string>)` is invisible to
 * the bundler and fails inside the binary). A driver that throws while registering
 * is logged and skipped; the server still boots without that harness.
 */
export async function registerBundledDrivers(registry: DriverRegistry, providers: ProviderConfigs, log: Log): Promise<void> {
  for (const driver of Object.values(BUNDLED)) {
    try {
      registry.register(driver, providers[driver.kind]);
    } catch (err) {
      log(`[provider] failed to register ${driver.kind}`, err instanceof Error ? err.message : err);
    }
  }
}

const BUNDLED: Record<Exclude<ProviderKind, "acp">, AnyDriver> = {
  claude: claudeDriver as AnyDriver,
  codex: codexDriver as AnyDriver,
  opencode: opencodeDriver as AnyDriver,
  pi: piDriver as AnyDriver,
};

/** Settings instances run on the bundled drivers, ACP agents on `acpDriver`. */
export function createBundledInstanceFactory(deps: { providers: ProviderConfigs; acp: Pick<AcpRegistry, "find"> }): InstanceFactory {
  return createInstanceFactory({ ...deps, drivers: { ...BUNDLED, acp: acpDriver as unknown as AnyDriver } });
}
