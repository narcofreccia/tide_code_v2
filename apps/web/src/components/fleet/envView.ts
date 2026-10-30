import type { EnvRoute, KnownEnvironment, ServerInfo } from "@tide/contracts";
import { httpOriginFor, resolveServerUrl, wsUrlFor } from "../../lib/bootstrap.ts";
import { useEnvironments, type EnvConnection, type EnvStatus, type EnvironmentsState } from "../../state/environments.ts";

/**
 * Pure helpers the fleet surfaces share: which environments are live, how to describe their
 * state, and how to turn a route into the origin a browser or an editor can open.
 */

export type HostFacts = NonNullable<ServerInfo["host"]>;

export const ROUTE_KINDS: EnvRoute["kind"][] = ["local", "lan", "tailscale", "ssh", "relay", "custom"];

export const ROUTE_LABELS: Record<EnvRoute["kind"], string> = {
  local: "this computer",
  lan: "LAN",
  tailscale: "Tailscale",
  ssh: "SSH tunnel",
  relay: "relay",
  custom: "custom URL",
};

/** Shared fallback: selectors must return a stable object, not a fresh one per call. */
const UNKNOWN: EnvStatus = { connection: "offline" };

export function statusOf(state: EnvironmentsState, id: string): EnvStatus {
  return state.statuses[id] ?? UNKNOWN;
}

/** Environments with a live connection, primary first. */
export function connectedEnvs(state: EnvironmentsState): KnownEnvironment[] {
  const live = state.environments.filter((e) => statusOf(state, e.id).connection === "connected");
  return [...live].sort((a, b) => Number(b.id === state.primaryId) - Number(a.id === state.primaryId));
}

/** Read live: what a picker or a tag needs. Only re-renders on the store's own changes. */
export function useConnectedEnvs(): KnownEnvironment[] {
  return connectedEnvs(useEnvironments());
}

/** Tags and "Run on" pickers only appear once there is a choice to make. */
export function useMultiEnv(): boolean {
  return useEnvironments((s) => s.environments.length > 1);
}

/** "Connected via LAN" / "Offline" / "Not paired". */
export function connectionLabel(status: EnvStatus): string {
  switch (status.connection) {
    case "connected":
      return status.route ? `Connected via ${ROUTE_LABELS[status.route.kind]}` : "Connected";
    case "connecting":
      return "Connecting…";
    case "unauthorized":
      return "Not paired — the token was refused";
    default:
      return "Offline";
  }
}

export const CONNECTION_TONE: Record<EnvConnection, "ok" | "pending" | "bad" | "off"> = {
  connected: "ok",
  connecting: "pending",
  unauthorized: "bad",
  offline: "off",
};

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

/** What the user typed (page URL, host:port or socket URL) → the socket URL routes store. */
export function toWsUrl(input: string): string | undefined {
  const raw = input.trim();
  if (raw === "") return undefined;
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol === "ws:" || parsed.protocol === "wss:") return parsed.toString().replace(/\/$/, "");
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return wsUrlFor(parsed.toString());
  } catch {
    /* fall through */
  }
  return undefined;
}

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const TAILNET_V4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

export function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

/** A best guess at the route kind from the URL; the user can change it on the card. */
export function guessRouteKind(url: string): EnvRoute["kind"] {
  if (isLoopback(url)) return "local";
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return "custom";
  }
  if (host.endsWith(".ts.net") || TAILNET_V4.test(host)) return "tailscale";
  if (PRIVATE_V4.test(host) || host.endsWith(".local")) return "lan";
  return "custom";
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

/** Whether an environment is the machine this client runs on (reached over loopback). */
export function isLocalEnv(envId: string | undefined, state: EnvironmentsState = useEnvironments.getState()): boolean {
  if (envId !== undefined) {
    const env = state.environments.find((e) => e.id === envId);
    const route = activeRoute(env, state.statuses[envId]);
    if (route) return route.kind === "local" || isLoopback(route.url);
  }
  return isLoopback(resolveServerUrl());
}

/** `user@host` for SSH editor links: the client's own setting wins over what the server reports. */
export function envSshHost(envId: string | undefined, state: EnvironmentsState = useEnvironments.getState()): string | undefined {
  if (envId === undefined) return undefined;
  const env = state.environments.find((e) => e.id === envId);
  const host = env?.sshHost ?? state.statuses[envId]?.info?.sshHost;
  return host === undefined || host.trim() === "" ? undefined : host.trim();
}

/** 0..1, how much memory is in use. */
export function memUse(host: HostFacts): number {
  if (host.memTotal <= 0) return 0;
  return Math.min(1, Math.max(0, (host.memTotal - host.memFree) / host.memTotal));
}

export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

export function percent(value: number): string {
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}

/** "claude 2.1.3 · codex 0.48" — installed harnesses only. */
export function harnessSummary(info: ServerInfo | undefined): string {
  const installed = (info?.harnesses ?? []).filter((h) => h.installed);
  if (installed.length === 0) return "—";
  return installed.map((h) => (h.version ? `${h.kind} ${h.version}` : h.kind)).join(" · ");
}

/** "macOS arm64 · 10 cores". */
export function hostLine(host: HostFacts | undefined): string {
  if (!host) return "—";
  const os = host.os === "darwin" ? "macOS" : host.os === "win32" ? "Windows" : host.os === "linux" ? "Linux" : host.os;
  return `${host.hostname} · ${os} ${host.arch} · ${host.cpus} cores`;
}

/** The routing option for `call` / `dispatch`: omitted when no environment is named. */
export function envOpt(envId: string | undefined): { envId: string } | undefined {
  return envId === undefined ? undefined : { envId };
}
