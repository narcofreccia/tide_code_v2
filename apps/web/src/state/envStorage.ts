import { useEnvironments } from "./envStore.ts";
import { useModel } from "./model.ts";

/**
 * R9: per-environment localStorage for per-thread client state.
 *
 * A store keeps writing one JSON blob; this layer splits its per-thread maps by the
 * environment that owns each thread and writes them under `<key>@<envId>`, keeping the
 * client-wide fields under `<key>`. Reading merges `<key>` and every `<key>@*` back
 * into one blob, so stores never see the split. Removing an environment purges its
 * buckets; the provisional local id is renamed once the server tells its real id.
 *
 * Until any environment is known (tests, first paint) the blob is written as is, which is
 * also the legacy format — `migrateEnvStorage` moves those values under the local env.
 *
 * Client-wide state stays unscoped: `tide.ui` (layout), `tide.terminals` (drawer size),
 * `tide.palette.recents` (palette history) hold nothing per thread.
 */

interface ScopedSpec {
  /** the per-thread maps (keyed by thread id, or `new:<projectId>` for drafts) */
  fields: readonly string[];
  /** zustand `persist` blobs keep the state under `state` */
  wrapped: boolean;
}

export const SCOPED_SPECS: Readonly<Record<string, ScopedSpec>> = {
  "tide.lastSeen": { fields: ["seen"], wrapped: false },
  "tide.workbench": { fields: ["tabs", "active"], wrapped: true },
  "tide.drafts.v1": { fields: ["drafts"], wrapped: false },
};

const SEP = "@";

export function envStorageKey(base: string, envId: string): string {
  return `${base}${SEP}${envId}`;
}

type Json = Record<string, unknown>;

/** `${base}@${id}` → the bucket each entry was read from, so an entry whose owner is unknown stays put */
const loadedFrom = new Map<string, string>();

function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function parse(raw: string | null): Json | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null ? (value as Json) : undefined;
  } catch {
    return undefined;
  }
}

function bucketKeys(store: Storage, base: string): string[] {
  const prefix = base + SEP;
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

function stateOf(blob: Json, wrapped: boolean): Json {
  if (!wrapped) return blob;
  const state = blob.state;
  if (typeof state === "object" && state !== null) return state as Json;
  const fresh: Json = {};
  blob.state = fresh;
  return fresh;
}

function mapOf(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

/** Owner of a per-thread key: the thread, else a project (`new:<projectId>` draft keys). */
function ownerOfKey(key: string): string | undefined {
  const { threads, projects } = useModel.getState().ownership;
  const direct = threads[key] ?? projects[key];
  if (direct !== undefined) return direct;
  const at = key.indexOf(":");
  if (at < 0) return undefined;
  const rest = key.slice(at + 1);
  return threads[rest] ?? projects[rest];
}

function fallbackEnv(): string | undefined {
  const { primaryId, environments } = useEnvironments.getState();
  return primaryId ?? environments[0]?.id;
}

/** The blob a store persisted, with every environment's bucket merged back in. */
export function readScoped(base: string): string | null {
  const store = storage();
  if (!store) return null;
  const spec = SCOPED_SPECS[base];
  const raw = store.getItem(base);
  if (!spec) return raw;
  const keys = bucketKeys(store, base);
  if (keys.length === 0) return raw;
  const blob = parse(raw) ?? (spec.wrapped ? { state: {}, version: 0 } : {});
  const state = stateOf(blob, spec.wrapped);
  for (const key of keys) {
    const envId = key.slice(base.length + SEP.length);
    const bucket = parse(store.getItem(key));
    if (!bucket) continue;
    for (const field of spec.fields) {
      const entries = mapOf(bucket[field]);
      state[field] = { ...mapOf(state[field]), ...entries };
      for (const id of Object.keys(entries)) loadedFrom.set(`${base}${SEP}${id}`, envId);
    }
  }
  return JSON.stringify(blob);
}

/** Writes a store's blob: per-thread maps to their owner's bucket, the rest to `base`. */
export function writeScoped(base: string, raw: string): void {
  const store = storage();
  if (!store) return;
  const spec = SCOPED_SPECS[base];
  const fallback = fallbackEnv();
  const blob = spec && fallback !== undefined ? parse(raw) : undefined;
  if (!spec || fallback === undefined || !blob) {
    store.setItem(base, raw);
    return;
  }
  const state = stateOf(blob, spec.wrapped);
  const buckets = new Map<string, Json>();
  for (const field of spec.fields) {
    for (const [id, value] of Object.entries(mapOf(state[field]))) {
      const envId = ownerOfKey(id) ?? loadedFrom.get(`${base}${SEP}${id}`) ?? fallback;
      loadedFrom.set(`${base}${SEP}${id}`, envId);
      const bucket = buckets.get(envId) ?? {};
      bucket[field] = { ...mapOf(bucket[field]), [id]: value };
      buckets.set(envId, bucket);
    }
    state[field] = {};
  }
  store.setItem(base, JSON.stringify(blob));
  const stale = new Set(bucketKeys(store, base));
  for (const [envId, bucket] of buckets) {
    const key = envStorageKey(base, envId);
    stale.delete(key);
    store.setItem(key, JSON.stringify(bucket));
  }
  for (const key of stale) store.removeItem(key);
}

/** A zustand `persist` storage over readScoped / writeScoped. */
export const scopedStateStorage = {
  getItem: (name: string): string | null => readScoped(name),
  setItem: (name: string, value: string): void => writeScoped(name, value),
  removeItem: (name: string): void => {
    const store = storage();
    if (!store) return;
    store.removeItem(name);
    for (const key of bucketKeys(store, name)) store.removeItem(key);
  },
};

/** Forgets everything stored for one environment (it was removed). */
export function purgeEnvStorage(envId: string): void {
  const store = storage();
  if (!store) return;
  for (const base of Object.keys(SCOPED_SPECS)) store.removeItem(envStorageKey(base, envId));
  for (const [key, env] of [...loadedFrom]) if (env === envId) loadedFrom.delete(key);
}

/** Moves an environment's buckets to a new id (the provisional local env learned its id). */
export function renameEnvStorage(from: string, to: string): void {
  const store = storage();
  if (!store || from === to) return;
  for (const [base, spec] of Object.entries(SCOPED_SPECS)) {
    const source = parse(store.getItem(envStorageKey(base, from)));
    if (!source) continue;
    const target = parse(store.getItem(envStorageKey(base, to))) ?? {};
    for (const field of spec.fields) target[field] = { ...mapOf(target[field]), ...mapOf(source[field]) };
    store.setItem(envStorageKey(base, to), JSON.stringify(target));
    store.removeItem(envStorageKey(base, from));
  }
  for (const [key, env] of [...loadedFrom]) if (env === from) loadedFrom.set(key, to);
}

/**
 * One-time move of the legacy single-server blobs: their per-thread maps go under the
 * local environment's bucket, client-wide fields stay where they are. Idempotent.
 */
export function migrateEnvStorage(localEnvId: string): void {
  const store = storage();
  if (!store) return;
  for (const [base, spec] of Object.entries(SCOPED_SPECS)) {
    const blob = parse(store.getItem(base));
    if (!blob) continue;
    const state = stateOf(blob, spec.wrapped);
    const moved: Json = {};
    let any = false;
    for (const field of spec.fields) {
      const entries = mapOf(state[field]);
      if (Object.keys(entries).length === 0) continue;
      moved[field] = entries;
      state[field] = {};
      any = true;
      for (const id of Object.keys(entries)) loadedFrom.set(`${base}${SEP}${id}`, localEnvId);
    }
    if (!any) continue;
    const key = envStorageKey(base, localEnvId);
    const target = parse(store.getItem(key)) ?? {};
    for (const field of spec.fields) target[field] = { ...mapOf(moved[field]), ...mapOf(target[field]) };
    store.setItem(key, JSON.stringify(target));
    store.setItem(base, JSON.stringify(blob));
  }
}

/** Test seam. */
export function resetEnvStorage(): void {
  loadedFrom.clear();
}
