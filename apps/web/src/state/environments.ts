import { create } from "zustand";
import type { EnvRoute, KnownEnvironment, ServerInfo } from "@tide/contracts";

/**
 * R9: the environments (machines running tide-server) this client knows about.
 *
 * Contract between the connection-manager work (packages/client + this file's internals) and
 * the fleet UI: the UI imports only what is exported here. The list is client-side state,
 * persisted in localStorage under `tide.environments.v1`; a server never sees it.
 *
 * `primaryId` is the environment that answers environment-less RPCs (settings.*, providers.*)
 * and whose settings panels are shown; project/thread-scoped calls are routed by ownership
 * (see `envOfProject` / `envOfThread`).
 */

export type EnvConnection = "connecting" | "connected" | "unauthorized" | "offline";

export interface EnvStatus {
  connection: EnvConnection;
  /** the route that is currently carrying the connection */
  route?: EnvRoute;
  info?: ServerInfo;
  /** last error text when offline / unauthorized */
  error?: string;
  lastSeenAt?: number;
}

export interface EnvironmentsState {
  environments: KnownEnvironment[];
  statuses: Record<string, EnvStatus>;
  primaryId: string | undefined;
}

export interface AddEnvironmentInput {
  name?: string;
  routes: EnvRoute[];
  token?: string;
  sshHost?: string;
}

export const useEnvironments = create<EnvironmentsState>(() => ({
  environments: [],
  statuses: {},
  primaryId: undefined,
}));

// ---- actions (implemented by the connection-manager slice; the UI only calls them) ----

/** Adds (or merges by id once probed) and connects. Resolves with the environment id. */
export async function addEnvironment(_input: AddEnvironmentInput): Promise<string> {
  throw new Error("environments: not wired yet");
}

/** `POST /api/auth/pair {code}` on `httpUrl`, then addEnvironment with the returned token. */
export async function pairWithCode(_httpUrl: string, _code: string): Promise<string> {
  throw new Error("environments: not wired yet");
}

export function removeEnvironment(_id: string): void {
  throw new Error("environments: not wired yet");
}

export function setPrimaryEnvironment(_id: string): void {
  throw new Error("environments: not wired yet");
}

export function updateEnvironment(_id: string, _patch: Partial<Pick<KnownEnvironment, "name" | "routes" | "sshHost">>): void {
  throw new Error("environments: not wired yet");
}

/** Re-probe every route of every environment (`GET /api/env`) and reconnect where a better route answers. */
export async function probeEnvironments(): Promise<void> {
  throw new Error("environments: not wired yet");
}

// ---- lookups (pure, from the merged read model) ----

/** Environment that owns a project; undefined for an unknown project. */
export function envOfProject(_projectId: string): string | undefined {
  return undefined;
}

export function envOfThread(_threadId: string): string | undefined {
  return undefined;
}

export function environmentName(id: string | undefined): string {
  if (id === undefined) return "this machine";
  const env = useEnvironments.getState().environments.find((e) => e.id === id);
  return env?.name ?? useEnvironments.getState().statuses[id]?.info?.name ?? id;
}
