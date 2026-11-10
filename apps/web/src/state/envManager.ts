import {
  EnvironmentConnection,
  MergedModel,
  routeFor,
  onPageHidden,
  scheduleFrame,
  type ConnectionStatus,
  type FrameScheduler,
  type EnvConnectionSnapshot,
  type EnvironmentConnectionOptions,
  type FetchLike,
  type StreamHandle,
} from "@tide/client";
import { PROTOCOL_VERSION, type ClientCommand, type EnvRoute, type KnownEnvironment, type ServerInfo } from "@tide/contracts";
import { useEnvironments, type EnvConnection, type EnvStatus } from "./envStore.ts";
import { loadEnvironments, saveEnvironments } from "./envPersist.ts";
import { migrateEnvStorage, purgeEnvStorage, renameEnvStorage } from "./envStorage.ts";
import {
  setDispatcher,
  setRpcCaller,
  setRpcStreamer,
  useModel,
  type Dispatcher,
  type RouteOptions,
  type RpcCaller,
  type RpcStreamer,
  type StreamControl,
} from "./model.ts";
import { dropProvidersFor, loadProvidersFor, reorderProviders } from "./providers.ts";
import { runReconnectHandlers } from "./reconnect.ts";
import { routeEnv, type RouteContext } from "./routing.ts";
import { loadServerSettings } from "./serverSettings.ts";
import { showToast } from "./toast.ts";
import { mixedContentReason } from "../lib/routeSecurity.ts";

/**
 * R9 connection manager: one EnvironmentConnection per known environment, their read
 * models merged into `useModel`, and the routed `call` / `stream` / `dispatch` installed
 * into `model.ts`. `environments.ts` is the public API on top of it.
 */

/** Id of the local environment until its server says who it is. */
export const PROVISIONAL_LOCAL_ID = "local";
/** R17: id of a machine the desktop shell opened with `?remote=1`, until it answers. */
export const PROVISIONAL_REMOTE_ID = "remote";

/** Records whose id is a placeholder: whoever answers on their route is adopted. */
function adoptsAnswerer(env: KnownEnvironment | undefined): boolean {
  return env?.id === PROVISIONAL_REMOTE_ID || isLocalEnv(env);
}

export type EnvConnectionLike = Pick<
  EnvironmentConnection,
  "store" | "snapshot" | "onChange" | "start" | "stop" | "setToken" | "setRoutes" | "probe" | "call" | "stream"
>;
export type ConnectionFactory = (opts: EnvironmentConnectionOptions) => EnvConnectionLike;

interface Entry {
  /** mutable: the provisional local id is replaced in place */
  id: string;
  conn: EnvConnectionLike;
  offs: (() => void)[];
  everConnected: boolean;
  lastState?: EnvConnection;
  lastRoute?: string | undefined;
}

const entries = new Map<string, Entry>();
const merged = new MergedModel();
const ptyOwners = new Map<string, string>();
let flushQueued = false;

const defaultFactory: ConnectionFactory = (opts) => new EnvironmentConnection(opts);
let factory: ConnectionFactory = defaultFactory;
let fetchOverride: FetchLike | undefined;

/** Test seams. */
export function setConnectionFactory(next: ConnectionFactory | undefined): void {
  factory = next ?? defaultFactory;
}
export function setEnvFetch(next: FetchLike | undefined): void {
  fetchOverride = next;
}
export function envFetch(): FetchLike {
  return fetchOverride ?? ((url, init) => (globalThis as unknown as { fetch: FetchLike }).fetch(url, init));
}

export function isLocalEnv(env: KnownEnvironment | undefined): boolean {
  return env?.routes.some((r) => r.kind === "local") ?? false;
}

function envById(id: string): KnownEnvironment | undefined {
  return useEnvironments.getState().environments.find((e) => e.id === id);
}

// ---- persistence ----

export function persist(): void {
  const { environments, primaryId } = useEnvironments.getState();
  saveEnvironments({ environments, ...(primaryId === undefined ? {} : { primaryId }), ownership: merged.ownership });
}

/** Patches one environment record (by current id) and persists. */
export function patchEnv(id: string, patch: Partial<KnownEnvironment>): void {
  useEnvironments.setState((s) => ({ environments: s.environments.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
  persist();
}

// ---- merged model ----

/*
 * At most one `useModel.setState` per animation frame: every environment's store updates
 * merge on the shared frame (`scheduleFrame` runs a store's publish and this merge in one
 * pass). Command receipts and a page going hidden flush at once.
 */
let scheduleMerge: FrameScheduler = scheduleFrame;

/** Test seam: how merges are scheduled (the fakes use a microtask); undefined restores the frame. */
export function setFrameScheduler(next: FrameScheduler | undefined): void {
  scheduleMerge = next ?? scheduleFrame;
}

function flushIfQueued(): void {
  if (flushQueued) flushModel();
}

function scheduleFlush(): void {
  if (flushQueued) return;
  flushQueued = true;
  scheduleMerge(flushIfQueued);
}

onPageHidden(flushIfQueued);

/** Recomputes the merged view once per batch of store updates. */
export function flushModel(): void {
  flushQueued = false;
  const before = merged.ownership;
  const changed = merged.commit();
  const ownership = merged.ownership;
  const current = useModel.getState();
  // ready lands with the merged model it describes, so no frame is "ready but empty"
  const ready = current.ready || primaryReady();
  if (changed || ownership !== current.ownership || ready !== current.ready) useModel.setState({ model: merged.model, ownership, ready });
  if (ownership !== before) persist();
}

/** The primary's store has had its first snapshot (a store that does not track it counts as ready). */
function primaryReady(): boolean {
  const { primaryId } = useEnvironments.getState();
  const entry = primaryId === undefined ? undefined : entries.get(primaryId);
  return entry !== undefined && entry.conn.store.getState().ready !== false;
}

// ---- statuses ----

function toConnectionStatus(state: EnvConnection | undefined, everConnected: boolean): ConnectionStatus {
  if (state === "connected") return "open";
  if (state === "unauthorized" || state === undefined) return "closed";
  return everConnected ? "reconnecting" : "connecting";
}

/** `useModel.status / lastError / environmentId` follow the primary environment. */
export function mirrorPrimary(): void {
  const { primaryId, statuses } = useEnvironments.getState();
  const entry = primaryId === undefined ? undefined : entries.get(primaryId);
  const status = primaryId === undefined ? undefined : statuses[primaryId];
  useModel.setState({
    environmentId: primaryId === undefined || primaryId === PROVISIONAL_LOCAL_ID || primaryId === PROVISIONAL_REMOTE_ID ? null : primaryId,
    status: toConnectionStatus(status?.connection, entry?.everConnected ?? false),
    lastError: status === undefined || status.connection === "connected" ? null : (status.error ?? null),
  });
}

/**
 * `routes`: the environment's routes. R19: when the socket fails and the browser refuses every
 * route as mixed content (an https page, plain ws:// to another machine), the error says so.
 */
export function toEnvStatus(snap: EnvConnectionSnapshot, routes: readonly EnvRoute[] = []): EnvStatus {
  const blocked = snap.state === "offline" || snap.state === "connecting" ? mixedContentReason(routes) : undefined;
  const error = snap.error !== undefined ? (blocked ?? snap.error) : undefined;
  return {
    connection: snap.state,
    ...(snap.route ? { route: snap.route } : {}),
    ...(snap.info ? { info: snap.info } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(snap.lastSeenAt !== undefined ? { lastSeenAt: snap.lastSeenAt } : {}),
  };
}

// ---- R6: version skew ----

/**
 * The wire protocol a server speaks, from its `server.info` (`protocol`, read as optional: a
 * server that predates the field says nothing and is not flagged).
 */
export function protocolOf(info: ServerInfo | undefined): number | undefined {
  return info?.protocol;
}

/** True when the server is known to speak another protocol than this client. */
export function protocolDiffers(info: ServerInfo | undefined): boolean {
  const protocol = protocolOf(info);
  return protocol !== undefined && protocol !== PROTOCOL_VERSION;
}

/** "<machine> runs Tide <version> with a different protocol; update it or this app" */
export function protocolWarning(name: string, info: ServerInfo | undefined): string {
  return `${name} runs Tide ${info?.version ?? "(unknown version)"} with a different protocol; update it or this app`;
}

/** primaries already warned about this session: the toast says it once, the machine card keeps it */
const protocolWarned = new Set<string>();

function warnPrimaryProtocol(id: string, info: ServerInfo | undefined): void {
  if (!protocolDiffers(info) || protocolWarned.has(id)) return;
  protocolWarned.add(id);
  showToast(protocolWarning(envById(id)?.name || info?.name || "This machine", info), undefined, { ms: 12_000 });
}

function onSnapshot(entry: Entry, snap: EnvConnectionSnapshot): void {
  if (!entries.has(entry.id) || entries.get(entry.id) !== entry) return;
  // the local environment is whoever answers on its route: adopt the real id
  if (snap.environmentId !== undefined && snap.environmentId !== entry.id && adoptsAnswerer(envById(entry.id))) {
    rekeyEnvironment(entry.id, snap.environmentId);
  }
  const id = entry.id;
  useEnvironments.setState((s) => ({ statuses: { ...s.statuses, [id]: toEnvStatus(snap, envById(id)?.routes) } }));
  const prevState = entry.lastState;
  const prevRoute = entry.lastRoute;
  entry.lastState = snap.state;
  entry.lastRoute = snap.route?.url;
  const isPrimary = id === useEnvironments.getState().primaryId;
  if (snap.state === "connected" && prevState !== "connected") {
    const reconnected = entry.everConnected;
    entry.everConnected = true;
    patchEnv(id, { lastConnectedAt: Date.now() });
    // a server without settings.get keeps the defaults; nothing to tell the user
    loadServerSettings(id).catch(() => undefined);
    loadProvidersFor(id);
    // the primary's re-subscribe runs from reconnect.ts (with the toast)
    if (reconnected && !isPrimary) runReconnectHandlers(id);
  } else if (snap.state === "connected" && prevRoute !== undefined && prevRoute !== snap.route?.url) {
    // moved to a better route: long-lived streams died with the old socket
    runReconnectHandlers(id);
  }
  const env = envById(id);
  if (env && env.name === "" && snap.info?.name) patchEnv(id, { name: snap.info.name });
  if (isPrimary) {
    mirrorPrimary();
    warnPrimaryProtocol(id, snap.info);
  }
}

// ---- lifecycle ----

function authMode(env: KnownEnvironment): "token" | "ticket" {
  // the server only accepts raw tokens on the socket in --dev, and never a paired device's token
  return import.meta.env.DEV && env.clientId === undefined ? "token" : "ticket";
}

export function openEnvironment(env: KnownEnvironment): void {
  if (entries.has(env.id)) return;
  const conn = factory({
    id: env.id,
    verifyId: !adoptsAnswerer(env),
    routes: env.routes,
    ...(env.token === undefined ? {} : { token: env.token }),
    authMode: authMode(env),
    ...(fetchOverride ? { fetchImpl: fetchOverride } : {}),
  });
  const entry: Entry = { id: env.id, conn, offs: [], everConnected: false };
  entries.set(env.id, entry);
  const sync = (): void => {
    if (entries.get(entry.id) !== entry) return;
    merged.set(entry.id, conn.store.getState().model);
    scheduleFlush();
  };
  entry.offs.push(conn.store.subscribe(sync));
  entry.offs.push(conn.onChange((snap) => onSnapshot(entry, snap)));
  sync();
  conn.start();
  onSnapshot(entry, conn.snapshot);
}

export function closeEnvironment(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  entries.delete(id);
  for (const off of entry.offs) off();
  entry.conn.stop();
  merged.remove(id);
  for (const [pty, env] of [...ptyOwners]) if (env === id) ptyOwners.delete(pty);
  dropProvidersFor(id);
  scheduleFlush();
}

export function connectionOf(id: string): EnvConnectionLike | undefined {
  return entries.get(id)?.conn;
}

function unionRoutes(a: readonly EnvRoute[], b: readonly EnvRoute[]): EnvRoute[] {
  const byUrl = new Map<string, EnvRoute>();
  for (const r of [...a, ...b]) if (!byUrl.has(r.url)) byUrl.set(r.url, r);
  return [...byUrl.values()];
}

/** Merges two records of the same environment; `primary` wins field by field. */
export function mergeEnvRecords(primary: KnownEnvironment, other: KnownEnvironment | undefined, id: string): KnownEnvironment {
  const token = primary.token ?? other?.token;
  // the client id belongs to whichever token won
  const clientId = primary.token !== undefined ? primary.clientId : other?.clientId;
  const sshHost = primary.sshHost ?? other?.sshHost;
  const lastConnectedAt = primary.lastConnectedAt ?? other?.lastConnectedAt;
  return {
    id,
    name: primary.name || other?.name || "",
    routes: unionRoutes(primary.routes, other?.routes ?? []),
    addedAt: Math.min(primary.addedAt, other?.addedAt ?? primary.addedAt),
    ...(token === undefined ? {} : { token }),
    ...(clientId === undefined ? {} : { clientId }),
    ...(sshHost === undefined ? {} : { sshHost }),
    ...(lastConnectedAt === undefined ? {} : { lastConnectedAt }),
  };
}

/** An environment learned its real id: every index moves with it; a duplicate record folds in. */
export function rekeyEnvironment(from: string, to: string): void {
  const entry = entries.get(from);
  if (!entry || from === to) return;
  const duplicate = entries.get(to);
  if (duplicate) {
    entries.delete(to);
    for (const off of duplicate.offs) off();
    duplicate.conn.stop();
  }
  entries.delete(from);
  entry.id = to;
  entries.set(to, entry);
  merged.rename(from, to);
  for (const [pty, env] of [...ptyOwners]) if (env === from) ptyOwners.set(pty, to);
  renameEnvStorage(from, to);
  dropProvidersFor(from);

  const state = useEnvironments.getState();
  const fromEnv = state.environments.find((e) => e.id === from);
  const toEnv = state.environments.find((e) => e.id === to);
  const record = fromEnv ? mergeEnvRecords(fromEnv, toEnv, to) : toEnv;
  const environments = state.environments
    .filter((e) => e.id !== to)
    .map((e) => (e.id === from && record ? record : e));
  const { [from]: status, ...statuses } = state.statuses;
  const primaryId = state.primaryId === from || state.primaryId === to ? to : state.primaryId;
  useEnvironments.setState({
    environments,
    statuses: status ? { ...statuses, [to]: status } : statuses,
    primaryId,
  });
  if (record && fromEnv && record.routes.length !== fromEnv.routes.length) entry.conn.setRoutes(record.routes);
  persist();
  mirrorPrimary();
  scheduleFlush();
}

// ---- routing ----

const routeContext: RouteContext = {
  get primaryId() {
    return useEnvironments.getState().primaryId;
  },
  ownerOf: (kind, id) => (kind === "ptys" ? ptyOwners.get(id) : merged.ownerOf(kind, id)),
};

/** Which environment a call / command / stream with this subject goes to. */
export function envFor(subject: unknown, opts?: RouteOptions): string | undefined {
  return routeEnv(subject, opts, routeContext);
}

export function ownerOf(kind: "projects" | "threads", id: string): string | undefined {
  return merged.ownerOf(kind, id);
}

function entryFor(subject: unknown, opts: RouteOptions | undefined): Entry {
  const envId = envFor(subject, opts);
  const entry = envId === undefined ? undefined : entries.get(envId);
  if (!entry) throw new Error(envId === undefined ? "no environment connected" : `unknown environment: ${envId}`);
  return entry;
}

function notePtys(method: string, result: unknown, envId: string): void {
  if (method === "pty.create") {
    const ptyId = (result as { ptyId?: unknown }).ptyId;
    if (typeof ptyId === "string") ptyOwners.set(ptyId, envId);
  } else if (method === "pty.list") {
    for (const p of (result as { ptys?: { ptyId: string }[] }).ptys ?? []) ptyOwners.set(p.ptyId, envId);
  }
}

export const routedCall = ((method: string, params: unknown, opts?: RouteOptions) => {
  let entry: Entry;
  try {
    entry = entryFor(params, opts);
  } catch (err) {
    return Promise.reject(err);
  }
  // keep `this`: EnvironmentConnection.call is a prototype method
  const conn = entry.conn as unknown as { call(m: string, p: unknown): Promise<unknown> };
  return conn.call(method, params).then((result) => {
    notePtys(method, result, entry.id);
    return result;
  });
}) as RpcCaller;

export const routedStream = ((method: string, params: unknown, onChunk: (c: unknown) => void, opts?: RouteOptions): StreamControl => {
  let entry: Entry;
  try {
    entry = entryFor(params, opts);
  } catch (err) {
    const done = Promise.reject(err);
    done.catch(() => undefined);
    return { cancel: () => undefined, done };
  }
  const conn = entry.conn as unknown as { stream(m: string, p: unknown, cb: (c: unknown) => void): StreamHandle };
  return conn.stream(method, params, onChunk);
}) as RpcStreamer;

export const routedDispatch: Dispatcher = (command: ClientCommand, opts?: RouteOptions) => {
  let entry: Entry;
  try {
    entry = entryFor(command, opts);
  } catch (err) {
    return Promise.reject(err);
  }
  // the store publishes its receipt at once; the merged view must not wait for a frame either
  return entry.conn.store.dispatch(command).then((result) => {
    flushIfQueued();
    return result;
  });
};

// ---- boot ----

export interface LocalLaunch {
  /** the local server's socket URL (desktop sidecar `?server=`, VITE_TIDE_URL, page origin, default) */
  url: string;
  token: string;
  /**
   * R17: the desktop shell opened another machine (`?remote=1`): `url` / `token` name it, no
   * local route is synthesised and it becomes the primary. An empty `url` (a reload, the
   * hand-off already consumed) just restores the persisted list.
   */
  remote?: boolean;
  /** the per-device token's id from pairing (remote launches) */
  clientId?: string;
}

type Persisted = ReturnType<typeof loadEnvironments>;

/** The local launch: the local environment exists and points at this URL / token. */
function withLocal(persisted: Persisted, local: LocalLaunch): { environments: KnownEnvironment[]; localId: string } {
  const localRoute: EnvRoute = { kind: "local", url: local.url, priority: 0 };
  let environments = persisted?.environments ?? [];
  const existing = environments.find((e) => isLocalEnv(e));
  let localId: string;
  if (existing) {
    localId = existing.id;
    const token = local.token || existing.token;
    environments = environments.map((e) =>
      e.id === existing.id
        ? { ...e, routes: [localRoute, ...e.routes.filter((r) => r.kind !== "local")], ...(token ? { token } : {}) }
        : e,
    );
  } else {
    localId = PROVISIONAL_LOCAL_ID;
    const env: KnownEnvironment = { id: localId, name: "", routes: [localRoute], addedAt: Date.now(), ...(local.token ? { token: local.token } : {}) };
    environments = [env, ...environments.filter((e) => e.id !== localId)];
  }
  return { environments, localId };
}

/** The remote launch: upserts the named machine (matched by route URL) and makes it the primary. */
function withRemote(persisted: Persisted, launch: LocalLaunch): { environments: KnownEnvironment[]; primaryId: string | undefined } {
  // a never-answered placeholder for the local server has nothing worth keeping
  let environments = (persisted?.environments ?? []).filter((e) => e.id !== PROVISIONAL_LOCAL_ID);
  let primaryId = persisted?.primaryId;
  if (launch.url !== "") {
    const auth = { token: launch.token, ...(launch.clientId === undefined ? {} : { clientId: launch.clientId }) };
    const known = environments.find((e) => !isLocalEnv(e) && e.routes.some((r) => r.url === launch.url));
    if (known) {
      environments = environments.map((e) => {
        if (e.id !== known.id) return e;
        const { clientId: _old, ...rest } = e;
        return { ...rest, ...auth };
      });
      primaryId = known.id;
    } else {
      const env: KnownEnvironment = { id: PROVISIONAL_REMOTE_ID, name: "", routes: [routeFor(launch.url)], addedAt: Date.now(), ...auth };
      environments = [...environments.filter((e) => e.id !== PROVISIONAL_REMOTE_ID), env];
      primaryId = env.id;
    }
  }
  if (primaryId === undefined || !environments.some((e) => e.id === primaryId)) primaryId = environments[0]?.id;
  return { environments, primaryId };
}

/**
 * Restores the persisted environment list, makes sure the local environment exists and
 * points at this launch's local URL / token (never touching the user's other
 * environments or their primary choice), and connects everything. A remote launch
 * (`local.remote`) skips the local environment and makes the named machine the primary.
 */
export function startEnvironments(local: LocalLaunch): () => void {
  stopEnvironments();
  const persisted = loadEnvironments();
  let environments: KnownEnvironment[];
  let primaryId: string | undefined;
  if (local.remote) {
    ({ environments, primaryId } = withRemote(persisted, local));
  } else {
    let localId: string;
    ({ environments, localId } = withLocal(persisted, local));
    primaryId = persisted?.primaryId !== undefined && environments.some((e) => e.id === persisted.primaryId) ? persisted.primaryId : localId;
    migrateEnvStorage(localId);
  }
  useEnvironments.setState({ environments, statuses: {}, primaryId });
  useModel.setState({ ready: false });
  merged.seedOwnership(persisted?.ownership ?? { projects: {}, threads: {} });
  setRpcCaller(routedCall);
  setRpcStreamer(routedStream);
  setDispatcher(routedDispatch);
  for (const env of environments) openEnvironment(env);
  useModel.setState({ ownership: merged.ownership });
  mirrorPrimary();
  persist();
  return stopEnvironments;
}

export function stopEnvironments(): void {
  for (const id of [...entries.keys()]) closeEnvironment(id);
  setRpcCaller(undefined);
  setRpcStreamer(undefined);
  setDispatcher(undefined);
}

/** Retry now: the primary re-walks its routes instead of waiting out the backoff. */
export function retryPrimary(): void {
  const { primaryId } = useEnvironments.getState();
  if (primaryId !== undefined) entries.get(primaryId)?.conn.probe();
}

/** Switches the primary: settings and the status bar follow it. */
export function setPrimary(id: string): void {
  if (!envById(id)) throw new Error(`unknown environment: ${id}`);
  if (useEnvironments.getState().primaryId === id) return;
  useEnvironments.setState({ primaryId: id });
  persist();
  mirrorPrimary();
  reorderProviders();
  if (useEnvironments.getState().statuses[id]?.connection === "connected") loadServerSettings(id).catch(() => undefined);
}

/** Test seam: forget every connection and index. */
export function resetEnvManager(): void {
  stopEnvironments();
  ptyOwners.clear();
  protocolWarned.clear();
  merged.seedOwnership({ projects: {}, threads: {} });
  flushModel();
  setFrameScheduler(undefined);
  setConnectionFactory(undefined);
  setEnvFetch(undefined);
  useEnvironments.setState({ environments: [], statuses: {}, primaryId: undefined });
  useModel.setState({ ready: false });
}

export { purgeEnvStorage };
