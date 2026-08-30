import type { ProviderDriver } from "@tide/contracts";
import type { ProviderConfigs } from "../config.ts";
import type { DriverRegistry } from "./registry.ts";

type AnyDriver = ProviderDriver<Record<string, unknown>>;
type Log = (msg: string, data?: unknown) => void;

function isProviderDriver(value: unknown): value is AnyDriver {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["kind"] === "string" && typeof v["defaultConfig"] === "function" && typeof v["create"] === "function";
}

/**
 * The driver packages are optional at build time: the specifier is kept off the
 * static graph so the server boots (without that harness) when one is missing.
 */
async function importDriver(specifier: string, exportName: string, log: Log): Promise<AnyDriver | undefined> {
  const dynamic: string = specifier;
  try {
    const mod: unknown = await import(dynamic);
    const candidate = (mod as Record<string, unknown>)[exportName];
    if (!isProviderDriver(candidate)) {
      log(`[provider] ${specifier} does not export a ${exportName} ProviderDriver`);
      return undefined;
    }
    return candidate;
  } catch (err) {
    log(`[provider] ${specifier} unavailable`, err instanceof Error ? err.message : err);
    return undefined;
  }
}

/** Registers every driver package that resolves, with its `providers.<kind>` config. */
export async function registerBundledDrivers(registry: DriverRegistry, providers: ProviderConfigs, log: Log): Promise<void> {
  const claude = await importDriver("@tide/driver-claude", "claudeDriver", log);
  if (claude) registry.register(claude, providers.claude);
}
