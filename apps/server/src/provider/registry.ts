import type {
  DriverEnv,
  ProviderDriver,
  ProviderInstance,
  ProviderInstanceConfig,
  ProviderKind,
  ProviderStatus,
  ProviderStatusDto,
} from "@tide/contracts";

const STATUS_TTL_MS = 60_000;

const UNUSABLE_CAPS = {
  planMode: false,
  subagents: false,
  mcp: false,
  images: false,
  resume: false,
  contextUsage: false,
  openInTerminal: false,
} as const;

/** The four bundled harnesses; each has a default instance whose id is the kind. */
export const BUNDLED_KINDS: readonly ProviderKind[] = ["claude", "codex", "opencode", "pi"];

export const KIND_LABELS: Record<ProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
  acp: "ACP agent",
};

/** How one configured instance is started. `fingerprint` decides whether a settings change replaces it. */
export interface InstanceSpec {
  id: string;
  kind: ProviderKind;
  label: string;
  open: () => Promise<ProviderInstance>;
  fingerprint: string;
}

/** Turns a user instance from settings into a spec; load.ts owns the per-kind mapping. */
export type InstanceFactory = (config: ProviderInstanceConfig, env: DriverEnv) => InstanceSpec;

interface Entry extends InstanceSpec {
  instance?: Promise<ProviderInstance>;
}

export interface RegistryOptions {
  env: DriverEnv;
  now?: () => number;
  /** status cache lifetime; 0 disables caching */
  ttlMs?: number;
  /** builds user instances (settings.providerInstances); without it `syncInstances` is a no-op */
  factory?: InstanceFactory;
}

/** A driver that failed to start or answer is reported, never thrown, to the client. */
function unusable(entry: { id: string; kind: ProviderKind; label: string }, err: unknown): ProviderStatusDto {
  return {
    id: entry.id,
    kind: entry.kind,
    label: entry.label,
    installed: false,
    loggedIn: false,
    hint: err instanceof Error ? err.message : String(err),
    models: [],
    caps: { ...UNUSABLE_CAPS },
  };
}

function toDto(status: ProviderStatus, entry: { id: string; kind: ProviderKind; label: string }): ProviderStatusDto {
  const loginCommand = loginCommandOf(status);
  return {
    id: entry.id,
    kind: entry.kind,
    label: entry.label,
    installed: status.installed,
    loggedIn: status.loggedIn,
    ...(status.version !== undefined ? { version: status.version } : {}),
    ...(status.hint !== undefined ? { hint: status.hint } : {}),
    ...(loginCommand !== undefined ? { loginCommand } : {}),
    models: status.models.map((m) => ({
      id: m.id,
      label: m.label,
      ...(m.family !== undefined ? { family: m.family } : {}),
      ...(m.default !== undefined ? { default: m.default } : {}),
      ...(m.efforts !== undefined ? { efforts: m.efforts.map((e) => ({ id: e.id, label: e.label, ...(e.default !== undefined ? { default: e.default } : {}) })) } : {}),
    })),
    caps: { ...status.caps },
  };
}

/** Drivers may set loginCommand explicitly; otherwise the first backticked span of the hint is it. */
function loginCommandOf(status: { loginCommand?: string; hint?: string; loggedIn: boolean }): string | undefined {
  if (status.loginCommand) return status.loginCommand;
  if (status.loggedIn || !status.hint) return undefined;
  return /`([^`]+)`/.exec(status.hint)?.[1];
}

/**
 * Owns one lazily created ProviderInstance per configured instance (keyed by instance id:
 * the kind for the bundled defaults, the settings id for user-added accounts and ACP agents)
 * plus a short-lived status cache, so the UI can poll `providers.list` without respawning CLIs.
 */
export class DriverRegistry {
  #entries = new Map<string, Entry>();
  /** user instance ids in settings order */
  #userOrder: string[] = [];
  #status = new Map<string, { at: number; dto: ProviderStatusDto }>();
  /** replaced/removed instances still serving a live session; disposed once idle */
  #retired: Promise<ProviderInstance>[] = [];
  #inUse: (instance: ProviderInstance) => boolean = () => false;
  #factory: InstanceFactory | undefined;
  #env: DriverEnv;
  #now: () => number;
  #ttl: number;

  constructor(options: RegistryOptions) {
    this.#env = options.env;
    this.#now = options.now ?? (() => Date.now());
    this.#ttl = options.ttlMs ?? STATUS_TTL_MS;
    this.#factory = options.factory;
  }

  /** Registers the kind's default instance (id = kind). */
  register<C>(driver: ProviderDriver<C>, config?: Partial<C>): void {
    const merged: C = { ...driver.defaultConfig(), ...(config ?? {}) };
    const id = driver.kind;
    const label = KIND_LABELS[driver.kind];
    const env: DriverEnv = { ...this.#env, instance: { id, label } };
    this.#set({ id, kind: driver.kind, label, open: () => driver.create(merged, env), fingerprint: "" });
  }

  setFactory(factory: InstanceFactory): void {
    this.#factory = factory;
  }

  /** Who still runs a session on an instance; a busy instance is never disposed under it. */
  setInUse(check: (instance: ProviderInstance) => boolean): void {
    this.#inUse = check;
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  /** instance ids: registered defaults first, then user instances in settings order */
  list(): string[] {
    return this.#ordered().map((e) => e.id);
  }

  kindOf(id: string): ProviderKind | undefined {
    return this.#entries.get(id)?.kind;
  }

  labelOf(id: string): string | undefined {
    return this.#entries.get(id)?.label;
  }

  /** Creates the instance on first use and memoizes it. A bundled kind is its default instance's id. */
  async get(id: string): Promise<ProviderInstance> {
    const entry = this.#entries.get(id);
    if (!entry) throw new Error(`no driver registered for ${id}`);
    return this.#instanceOf(entry);
  }

  /**
   * Brings user instances in line with settings: new ids are added, changed ones replaced,
   * missing ones removed. A replaced/removed instance that still runs a session is kept alive
   * until that session closes (`sweepRetired`).
   */
  async syncInstances(list: readonly ProviderInstanceConfig[]): Promise<void> {
    const factory = this.#factory;
    if (!factory) {
      if (list.length > 0) this.#env.log("[provider] no instance factory; user instances ignored");
      return;
    }
    const wanted = new Set(list.map((c) => c.id));
    for (const id of this.#userOrder) {
      if (wanted.has(id)) continue;
      const gone = this.#entries.get(id);
      if (gone) this.#retire(gone);
      this.#entries.delete(id);
      this.#status.delete(id);
    }
    const order: string[] = [];
    for (const config of list) {
      if (BUNDLED_KINDS.includes(config.id as ProviderKind)) {
        this.#env.log(`[provider] instance id ${config.id} shadows a bundled harness; ignored`);
        continue;
      }
      let spec: InstanceSpec;
      try {
        spec = factory(config, this.#env);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        spec = { id: config.id, kind: config.kind, label: config.label, open: () => Promise.reject(new Error(message)), fingerprint: `error:${message}` };
      }
      order.push(spec.id);
      const current = this.#entries.get(spec.id);
      if (current && current.fingerprint === spec.fingerprint) continue;
      if (current) this.#retire(current);
      this.#set(spec);
    }
    this.#userOrder = order;
    await this.sweepRetired();
  }

  /** Disposes retired instances no session uses any more. */
  async sweepRetired(): Promise<void> {
    const keep: Promise<ProviderInstance>[] = [];
    for (const pending of this.#retired) {
      let instance: ProviderInstance;
      try {
        instance = await pending;
      } catch {
        continue; // never started: nothing to dispose
      }
      if (this.#inUse(instance)) {
        this.#env.log(`[provider] ${instance.kind} instance still has a live session; disposal deferred`);
        keep.push(pending);
        continue;
      }
      try {
        await instance.dispose();
      } catch (err) {
        this.#env.log("[provider] dispose failed", err);
      }
    }
    this.#retired = keep;
  }

  /** Every instance, so the UI can grey out the ones this server cannot drive. */
  async statusAll(refresh = false): Promise<ProviderStatusDto[]> {
    const missing = BUNDLED_KINDS.filter((kind) => !this.#entries.has(kind));
    const listed = this.#ordered();
    return Promise.all([
      ...listed.filter((e) => BUNDLED_KINDS.includes(e.id as ProviderKind)).map((e) => this.status(e.id, refresh)),
      ...missing.map((kind) => Promise.resolve(unusable({ id: kind, kind, label: KIND_LABELS[kind] }, new Error("driver not available in this build")))),
      ...listed.filter((e) => !BUNDLED_KINDS.includes(e.id as ProviderKind)).map((e) => this.status(e.id, refresh)),
    ]).then((dtos) => sortBundledFirst(dtos));
  }

  async status(id: string, refresh = false): Promise<ProviderStatusDto> {
    const entry = this.#entries.get(id);
    if (!entry) {
      const kind = BUNDLED_KINDS.find((k) => k === id) ?? "acp";
      return unusable({ id, kind, label: KIND_LABELS[kind] }, new Error(`no provider instance ${id}`));
    }
    const now = this.#now();
    const cached = this.#status.get(id);
    if (!refresh && cached && now - cached.at < this.#ttl) return cached.dto;
    let dto: ProviderStatusDto;
    try {
      const instance = await this.#instanceOf(entry);
      dto = toDto(await instance.status(), entry);
    } catch (err) {
      this.#env.log(`[provider] status(${id}) failed`, err);
      dto = unusable(entry, err);
    }
    // a sync may have replaced the entry while status() ran: never cache a stale answer
    if (this.#entries.get(id) === entry) this.#status.set(id, { at: now, dto });
    return dto;
  }

  async dispose(): Promise<void> {
    const pending = [...[...this.#entries.values()].flatMap((e) => (e.instance ? [e.instance] : [])), ...this.#retired].map(async (p) => {
      try {
        await (await p).dispose();
      } catch (err) {
        this.#env.log("[provider] dispose failed", err);
      }
    });
    await Promise.all(pending);
    this.#entries.clear();
    this.#status.clear();
    this.#retired = [];
    this.#userOrder = [];
  }

  #set(spec: InstanceSpec): void {
    this.#entries.set(spec.id, { ...spec });
    this.#status.delete(spec.id);
  }

  #retire(entry: Entry): void {
    if (entry.instance) this.#retired.push(entry.instance);
  }

  #instanceOf(entry: Entry): Promise<ProviderInstance> {
    entry.instance ??= entry.open().catch((err: unknown) => {
      delete entry.instance; // a failed start must not be cached forever
      throw err;
    });
    return entry.instance;
  }

  /** defaults (and any other non-settings registration) first, then user instances in settings order */
  #ordered(): Entry[] {
    const user = new Set(this.#userOrder);
    const fixed = [...this.#entries.values()].filter((e) => !user.has(e.id));
    const custom = this.#userOrder.flatMap((id) => {
      const e = this.#entries.get(id);
      return e ? [e] : [];
    });
    return [...fixed, ...custom];
  }
}

/** bundled defaults in their canonical order, everything else after in the order given */
function sortBundledFirst(dtos: ProviderStatusDto[]): ProviderStatusDto[] {
  const rank = (d: ProviderStatusDto): number => {
    const i = BUNDLED_KINDS.indexOf(d.id as ProviderKind);
    return i === -1 ? BUNDLED_KINDS.length : i;
  };
  return dtos.map((d, i) => ({ d, i })).sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i).map((x) => x.d);
}
