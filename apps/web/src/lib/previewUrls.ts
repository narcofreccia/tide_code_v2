import type { EnvRoute } from "@tide/contracts";
import { useEnvironments, type EnvironmentsState } from "../state/environments.ts";
import { activeRoute } from "./envOrigin.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DIRECT_KINDS: EnvRoute["kind"][] = ["lan", "tailscale", "custom"];

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The host a browser should use to reach a dev server on the environment's machine, or
 * undefined when that is the viewer's own machine (local env, unknown env, no usable route).
 */
function envHost(envId: string | undefined, state: EnvironmentsState): string | undefined {
  if (envId === undefined) return undefined;
  const env = state.environments.find((e) => e.id === envId);
  if (!env) return undefined;
  let route = activeRoute(env, state.statuses[envId]);
  if (route?.kind === "relay") {
    // A relay only forwards the Tide server's socket, not arbitrary dev-server ports, so use
    // a direct route to the same machine when one exists.
    route = [...env.routes]
      .filter((r) => DIRECT_KINDS.includes(r.kind))
      .sort((a, b) => a.priority - b.priority)[0];
  }
  if (!route || route.kind === "local" || route.kind === "relay") return undefined;
  const host = hostOf(route.url);
  return host === undefined || LOOPBACK_HOSTS.has(host) ? undefined : host;
}

/** `http://<host of the env's route>:<port>`; localhost for the local or an unknown env. */
export function previewUrlFor(envId: string | undefined, port: number, state: EnvironmentsState = useEnvironments.getState()): string {
  return `http://${envHost(envId, state) ?? "localhost"}:${port}`;
}

/** The host to show in placeholders: the env's, else `localhost`. */
export function previewHostFor(envId: string | undefined, state: EnvironmentsState = useEnvironments.getState()): string {
  return envHost(envId, state) ?? "localhost";
}

/** A loopback URL reported by the server, re-pointed at the env's host; other hosts untouched. */
export function rehostLoopback(url: string, envId: string | undefined, state: EnvironmentsState = useEnvironments.getState()): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return url;
  const host = envHost(envId, state);
  if (host === undefined) return url;
  parsed.hostname = host;
  return parsed.toString();
}
