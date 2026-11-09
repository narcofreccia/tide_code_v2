import type { EnvRoute, KnownEnvironment } from "@tide/contracts";
import { httpOriginFor, resolveServerUrl } from "./bootstrap.ts";
import { useEnvironments, type EnvStatus, type EnvironmentsState } from "../state/environments.ts";

/** ws://host:3777/ws → http://host:3777; a page URL passes through as its origin. */
export function httpOriginOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "ws:" || parsed.protocol === "wss:") return httpOriginFor(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
  } catch {
    /* not a URL */
  }
  return undefined;
}

/** The route carrying the connection, else the preferred one. */
export function activeRoute(env: KnownEnvironment | undefined, status: EnvStatus | undefined): EnvRoute | undefined {
  if (status?.route) return status.route;
  return [...(env?.routes ?? [])].sort((a, b) => a.priority - b.priority)[0];
}

/** The http origin a browser opens for an environment; the current server when none is known. */
export function envHttpOrigin(envId: string | undefined, state: EnvironmentsState = useEnvironments.getState()): string | undefined {
  if (envId !== undefined) {
    const env = state.environments.find((e) => e.id === envId);
    const route = activeRoute(env, state.statuses[envId]);
    if (route) return httpOriginOf(route.url);
  }
  return httpOriginOf(resolveServerUrl());
}
