import type { EnvProbe, EnvRoute, KnownEnvironment, PairResponse } from "@tide/contracts";
import { httpOriginFor, preflight, routeFor, sortRoutes, wsUrlFor } from "@tide/client";
import {
  closeEnvironment,
  connectionOf,
  envFetch,
  isLocalEnv,
  mergeEnvRecords,
  openEnvironment,
  ownerOf,
  patchEnv,
  persist,
  purgeEnvStorage,
  setPrimary,
} from "./envManager.ts";
import { useEnvironments } from "./envStore.ts";

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

export { useEnvironments, type EnvConnection, type EnvStatus, type EnvironmentsState } from "./envStore.ts";

export interface AddEnvironmentInput {
  name?: string;
  routes: EnvRoute[];
  token?: string;
  sshHost?: string;
}

/** Inserts or folds into an existing record with the same id, then (re)connects. */
function upsertEnvironment(id: string, input: AddEnvironmentInput, fallbackName: string): string {
  const state = useEnvironments.getState();
  const existing = state.environments.find((e) => e.id === id);
  const incoming: KnownEnvironment = {
    id,
    name: input.name ?? "",
    routes: input.routes,
    addedAt: Date.now(),
    ...(input.token === undefined ? {} : { token: input.token }),
    ...(input.sshHost === undefined ? {} : { sshHost: input.sshHost }),
  };
  const record = mergeEnvRecords(incoming, existing, id);
  if (record.name === "") record.name = fallbackName;
  if (existing) {
    useEnvironments.setState({ environments: state.environments.map((e) => (e.id === id ? record : e)) });
    persist();
    const conn = connectionOf(id);
    if (record.routes.length !== existing.routes.length) conn?.setRoutes(record.routes);
    if (record.token !== existing.token) conn?.setToken(record.token);
    return id;
  }
  useEnvironments.setState({ environments: [...state.environments, record] });
  persist();
  openEnvironment(record);
  return id;
}

/** Adds (or merges by id once probed) and connects. Resolves with the environment id. */
export async function addEnvironment(input: AddEnvironmentInput): Promise<string> {
  if (input.routes.length === 0) throw new Error("an environment needs at least one route");
  const routes = sortRoutes(input.routes);
  const fetchImpl = envFetch();
  const results = await Promise.all(routes.map((r) => preflight(r, fetchImpl)));
  const answered = results.find((r): r is { kind: "ok"; probe: EnvProbe } => r.kind === "ok");
  if (!answered) {
    const why = results.map((r, i) => `${routes[i]!.url}: ${r.kind === "ok" ? "ok" : r.kind === "unknown" ? `HTTP ${r.status}` : r.error}`);
    throw new Error(`No route answered as a Tide server (${why.join("; ")})`);
  }
  return upsertEnvironment(answered.probe.environmentId, input, answered.probe.name);
}

function isPairResponse(value: unknown): value is PairResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.environmentId === "string" && typeof v.token === "string";
}

/** `POST /api/auth/pair {code}` on `httpUrl`, then addEnvironment with the returned token. */
export async function pairWithCode(httpUrl: string, code: string): Promise<string> {
  const origin = httpOriginFor(httpUrl.includes("://") ? httpUrl : `http://${httpUrl}`);
  // no content-type header: a "simple" cross-origin request, no CORS preflight needed
  const response = await envFetch()(`${origin}/api/auth/pair`, { method: "POST", body: JSON.stringify({ code: code.trim() }) });
  if (!response.ok) {
    if (response.status === 429) throw new Error("Too many pairing attempts; wait a minute and try again");
    throw new Error(response.status === 401 || response.status === 403 || response.status === 400
      ? "The pairing code was refused (wrong or expired)"
      : `Pairing failed: HTTP ${response.status}`);
  }
  const body = await response.json();
  if (!isPairResponse(body)) throw new Error("Pairing failed: unexpected answer");
  const route = routeFor(wsUrlFor(origin));
  return upsertEnvironment(body.environmentId, { name: body.name, routes: [route], token: body.token }, body.name);
}

/** Disconnects, drops its model, ownership and stored per-thread state. The local environment stays. */
export function removeEnvironment(id: string): void {
  const state = useEnvironments.getState();
  const env = state.environments.find((e) => e.id === id);
  if (!env) return;
  if (isLocalEnv(env)) throw new Error("The local environment cannot be removed");
  closeEnvironment(id);
  purgeEnvStorage(id);
  const { [id]: _gone, ...statuses } = state.statuses;
  const environments = state.environments.filter((e) => e.id !== id);
  const fallback = environments.find((e) => isLocalEnv(e))?.id ?? environments[0]?.id;
  useEnvironments.setState({ environments, statuses });
  if (state.primaryId === id && fallback !== undefined) setPrimary(fallback);
  else if (state.primaryId === id) useEnvironments.setState({ primaryId: undefined });
  persist();
}

export function setPrimaryEnvironment(id: string): void {
  setPrimary(id);
}

export function updateEnvironment(id: string, patch: Partial<Pick<KnownEnvironment, "name" | "routes" | "sshHost">>): void {
  const env = useEnvironments.getState().environments.find((e) => e.id === id);
  if (!env) return;
  patchEnv(id, patch);
  if (patch.routes) connectionOf(id)?.setRoutes(patch.routes);
}

/** Re-probe every route of every environment (`GET /api/env`) and reconnect where a better route answers. */
export async function probeEnvironments(): Promise<void> {
  for (const env of useEnvironments.getState().environments) connectionOf(env.id)?.probe();
}

// ---- lookups (pure, from the merged read model) ----

/** Environment that owns a project; undefined for an unknown project. */
export function envOfProject(projectId: string): string | undefined {
  return ownerOf("projects", projectId);
}

export function envOfThread(threadId: string): string | undefined {
  return ownerOf("threads", threadId);
}

export function environmentName(id: string | undefined): string {
  if (id === undefined) return "this machine";
  const state = useEnvironments.getState();
  const env = state.environments.find((e) => e.id === id);
  return env?.name || state.statuses[id]?.info?.name || (env && isLocalEnv(env) ? "this machine" : id);
}
