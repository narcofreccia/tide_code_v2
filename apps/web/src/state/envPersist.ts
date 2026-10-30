import type { EnvRoute, KnownEnvironment } from "@tide/contracts";
import { emptyOwnership, type Ownership } from "@tide/client";

/** R9: the client's environment list, primary and ownership index, in one localStorage entry. */
export const ENVIRONMENTS_KEY = "tide.environments.v1";

export interface PersistedEnvironments {
  environments: KnownEnvironment[];
  primaryId?: string;
  ownership: Ownership;
}

const ROUTE_KINDS = new Set<EnvRoute["kind"]>(["local", "lan", "tailscale", "ssh", "relay", "custom"]);

function isRoute(value: unknown): value is EnvRoute {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.url === "string" && typeof r.priority === "number" && ROUTE_KINDS.has(r.kind as EnvRoute["kind"]);
}

function isEnvironment(value: unknown): value is KnownEnvironment {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return typeof e.id === "string" && typeof e.name === "string" && Array.isArray(e.routes) && e.routes.every(isRoute);
}

function stringMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export function loadEnvironments(): PersistedEnvironments | undefined {
  try {
    const raw = window.localStorage.getItem(ENVIRONMENTS_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const environments = Array.isArray(parsed.environments) ? parsed.environments.filter(isEnvironment) : [];
    const ownership = (parsed.ownership ?? {}) as Record<string, unknown>;
    return {
      environments: environments.map((e) => ({ ...e, addedAt: typeof e.addedAt === "number" ? e.addedAt : 0 })),
      ...(typeof parsed.primaryId === "string" ? { primaryId: parsed.primaryId } : {}),
      ownership: { projects: stringMap(ownership.projects), threads: stringMap(ownership.threads) },
    };
  } catch {
    return undefined;
  }
}

export function saveEnvironments(value: PersistedEnvironments): void {
  try {
    window.localStorage.setItem(ENVIRONMENTS_KEY, JSON.stringify(value));
  } catch {
    /* storage blocked: the list lives for this session only */
  }
}

export function emptyPersisted(): PersistedEnvironments {
  return { environments: [], ownership: emptyOwnership() };
}
