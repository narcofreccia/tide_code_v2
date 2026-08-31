import type { ProviderDriver } from "@tide/contracts";
import { claudeDriver } from "@tide/driver-claude";
import { codexDriver } from "@tide/driver-codex";
import { opencodeDriver } from "@tide/driver-opencode";
import { piDriver } from "@tide/driver-pi";
import type { ProviderConfigs } from "../config.ts";
import type { DriverRegistry } from "./registry.ts";

type AnyDriver = ProviderDriver<Record<string, unknown>>;
type Log = (msg: string, data?: unknown) => void;

/**
 * Driver packages are workspace dependencies and are imported statically so the
 * bun-compiled sidecar bundles them (a runtime `import(<string>)` is invisible to
 * the bundler and fails inside the binary). A driver that throws while registering
 * is logged and skipped; the server still boots without that harness.
 */
export async function registerBundledDrivers(registry: DriverRegistry, providers: ProviderConfigs, log: Log): Promise<void> {
  const bundled: { driver: AnyDriver; config: Record<string, unknown> | undefined }[] = [
    { driver: claudeDriver as AnyDriver, config: providers.claude },
    { driver: codexDriver as AnyDriver, config: providers.codex },
    { driver: opencodeDriver as AnyDriver, config: providers.opencode },
    { driver: piDriver as AnyDriver, config: providers.pi },
  ];
  for (const { driver, config } of bundled) {
    try {
      registry.register(driver, config);
    } catch (err) {
      log(`[provider] failed to register ${driver.kind}`, err instanceof Error ? err.message : err);
    }
  }
}
