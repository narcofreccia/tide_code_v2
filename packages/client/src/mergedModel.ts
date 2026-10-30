import { emptyReadModel, type ReadModel } from "@tide/contracts";

/** Every id-keyed map of the ReadModel (everything but `seq`). */
export type ModelMapKey = Exclude<keyof ReadModel, "seq">;

const MAP_KEYS = Object.keys(emptyReadModel()).filter((k): k is ModelMapKey => k !== "seq");

/** Which environment owns each project / thread. Persisted by the client so routing works before snapshots. */
export interface Ownership {
  projects: Record<string, string>;
  threads: Record<string, string>;
}

export function emptyOwnership(): Ownership {
  return { projects: {}, threads: {} };
}

function sameKeys(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * The union of several environments' read models. Each environment projects its own
 * events into its own ReadModel (`applyRecord` is per server, seqs are per server);
 * `commit()` rebuilds one merged view with structural sharing: a map that no
 * environment touched since the last commit keeps its identity, a map only one
 * environment has is passed through as is, and an unchanged commit keeps the same
 * merged object — so selectors written for one model work unchanged on the union.
 *
 * Ids are ULIDs and globally unique, so a plain union never collides in practice;
 * on a collision the environment added last wins.
 */
export class MergedModel {
  private readonly models = new Map<string, ReadModel>();
  private committedInputs = new Map<string, ReadModel>();
  private mergedValue: ReadModel = emptyReadModel();
  private ownershipValue: Ownership = emptyOwnership();
  private seed: Ownership = emptyOwnership();

  get model(): ReadModel {
    return this.mergedValue;
  }

  /** projects/threads → envId, from the live models plus the persisted seed */
  get ownership(): Ownership {
    return this.ownershipValue;
  }

  envIds(): string[] {
    return [...this.models.keys()];
  }

  modelOf(envId: string): ReadModel | undefined {
    return this.models.get(envId);
  }

  set(envId: string, model: ReadModel): void {
    this.models.set(envId, model);
  }

  /** Drops an environment's model and every seed entry that pointed at it. */
  remove(envId: string): void {
    this.models.delete(envId);
    this.seed = {
      projects: Object.fromEntries(Object.entries(this.seed.projects).filter(([, env]) => env !== envId)),
      threads: Object.fromEntries(Object.entries(this.seed.threads).filter(([, env]) => env !== envId)),
    };
    this.recomputeOwnership();
  }

  /** An environment learned its real id (the local env starts provisional). */
  rename(from: string, to: string): void {
    if (from === to) return;
    const model = this.models.get(from);
    const entries = [...this.models.entries()].filter(([id]) => id !== to);
    this.models.clear();
    for (const [id, m] of entries) this.models.set(id === from ? to : id, id === from && model ? model : m);
    const swap = (map: Record<string, string>): Record<string, string> =>
      Object.fromEntries(Object.entries(map).map(([k, env]) => [k, env === from ? to : env]));
    this.seed = { projects: swap(this.seed.projects), threads: swap(this.seed.threads) };
    this.committedInputs = new Map(); // force a rebuild on the next commit
    this.recomputeOwnership();
  }

  /** Ownership known from a previous session; live models always win over it. */
  seedOwnership(seed: Ownership): void {
    this.seed = { projects: { ...seed.projects }, threads: { ...seed.threads } };
    this.recomputeOwnership();
  }

  /** The environment whose model holds `id` in `kind`; seeded ownership for projects/threads. */
  ownerOf(kind: ModelMapKey, id: string): string | undefined {
    if (kind === "projects" || kind === "threads") {
      const owner = this.ownershipValue[kind][id];
      if (owner !== undefined && this.models.get(owner)?.[kind][id] !== undefined) return owner;
    }
    for (const [envId, model] of this.models) {
      if (Object.prototype.hasOwnProperty.call(model[kind], id)) return envId;
    }
    if (kind === "projects" || kind === "threads") return this.ownershipValue[kind][id];
    return undefined;
  }

  /** Recomputes the merged view; true when it changed. */
  commit(): boolean {
    const inputs = new Map(this.models);
    const prev = this.committedInputs;
    const sameSet = prev.size === inputs.size && [...inputs.keys()].every((k) => prev.has(k));
    if (sameSet && [...inputs].every(([k, m]) => prev.get(k) === m)) return false;

    const models = [...inputs.values()];
    const previous = this.mergedValue;
    const next = { ...previous } as ReadModel;
    let changed = !sameSet;
    for (const key of MAP_KEYS) {
      const touched = !sameSet || [...inputs].some(([k, m]) => prev.get(k)?.[key] !== m[key]);
      if (!touched) continue;
      const merged = unionMaps(models.map((m) => m[key] as Record<string, unknown>));
      if (merged !== previous[key]) {
        (next as unknown as Record<string, unknown>)[key] = merged;
        changed = true;
      }
    }
    const seq = models.reduce((sum, m) => sum + m.seq, 0);
    if (seq !== previous.seq) changed = true;
    next.seq = seq;
    const owned = !sameSet || [...inputs].some(([k, m]) => prev.get(k)?.projects !== m.projects || prev.get(k)?.threads !== m.threads);
    this.committedInputs = inputs;
    if (owned) this.recomputeOwnership();
    if (!changed) return false;
    this.mergedValue = next;
    return true;
  }

  private recomputeOwnership(): void {
    // a seed only stands in until its environment's own model has arrived (seq > 0):
    // after that the live model is the truth, so deleted ids do not linger in the index
    const pending = (env: string): boolean => (this.models.get(env)?.seq ?? 0) === 0;
    const projects: Record<string, string> = Object.fromEntries(Object.entries(this.seed.projects).filter(([, env]) => pending(env)));
    const threads: Record<string, string> = Object.fromEntries(Object.entries(this.seed.threads).filter(([, env]) => pending(env)));
    for (const [envId, model] of this.models) {
      for (const id of Object.keys(model.projects)) projects[id] = envId;
      for (const id of Object.keys(model.threads)) threads[id] = envId;
    }
    const prev = this.ownershipValue;
    if (sameKeys(prev.projects, projects) && sameKeys(prev.threads, threads)) return;
    this.ownershipValue = {
      projects: sameKeys(prev.projects, projects) ? prev.projects : projects,
      threads: sameKeys(prev.threads, threads) ? prev.threads : threads,
    };
  }
}

/** One map passes through untouched; several are shallow-merged into a new object. */
function unionMaps<T>(maps: Record<string, T>[]): Record<string, T> {
  const nonEmpty = maps.filter((m) => {
    for (const _ in m) return true;
    return false;
  });
  if (nonEmpty.length === 0) return maps[0] ?? {};
  if (nonEmpty.length === 1) return nonEmpty[0]!;
  return Object.assign({}, ...nonEmpty) as Record<string, T>;
}
