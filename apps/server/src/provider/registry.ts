import type {
  DriverEnv,
  ProviderDriver,
  ProviderInstance,
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

interface Entry {
  kind: ProviderKind;
  open: () => Promise<ProviderInstance>;
  instance?: Promise<ProviderInstance>;
}

export interface RegistryOptions {
  env: DriverEnv;
  now?: () => number;
  /** status cache lifetime; 0 disables caching */
  ttlMs?: number;
}

/** A driver that failed to start or answer is reported, never thrown, to the client. */
function unusable(kind: ProviderKind, err: unknown): ProviderStatusDto {
  return {
    kind,
    installed: false,
    loggedIn: false,
    hint: err instanceof Error ? err.message : String(err),
    models: [],
    caps: { ...UNUSABLE_CAPS },
  };
}

function toDto(status: ProviderStatus): ProviderStatusDto {
  return {
    kind: status.kind,
    installed: status.installed,
    loggedIn: status.loggedIn,
    ...(status.version !== undefined ? { version: status.version } : {}),
    ...(status.hint !== undefined ? { hint: status.hint } : {}),
    ...(status.loginCommand !== undefined ? { loginCommand: status.loginCommand } : {}),
    models: status.models.map((m) => ({
      id: m.id,
      label: m.label,
      ...(m.family !== undefined ? { family: m.family } : {}),
      ...(m.default !== undefined ? { default: m.default } : {}),
    })),
    caps: { ...status.caps },
  };
}

/**
 * Owns one lazily created ProviderInstance per harness plus a short-lived cache of
 * their status, so the UI can poll `providers.list` without respawning CLIs.
 */
const ALL_KINDS: readonly ProviderKind[] = ["claude", "codex", "opencode", "pi"];

export class DriverRegistry {
  #entries = new Map<ProviderKind, Entry>();
  #status = new Map<ProviderKind, { at: number; dto: ProviderStatusDto }>();
  #env: DriverEnv;
  #now: () => number;
  #ttl: number;

  constructor(options: RegistryOptions) {
    this.#env = options.env;
    this.#now = options.now ?? (() => Date.now());
    this.#ttl = options.ttlMs ?? STATUS_TTL_MS;
  }

  register<C>(driver: ProviderDriver<C>, config?: Partial<C>): void {
    const merged: C = { ...driver.defaultConfig(), ...(config ?? {}) };
    this.#entries.set(driver.kind, { kind: driver.kind, open: () => driver.create(merged, this.#env) });
    this.#status.delete(driver.kind);
  }

  has(kind: ProviderKind): boolean {
    return this.#entries.has(kind);
  }

  list(): ProviderKind[] {
    return [...this.#entries.keys()];
  }

  /** Creates the instance on first use and memoizes it. */
  async get(kind: ProviderKind): Promise<ProviderInstance> {
    const entry = this.#entries.get(kind);
    if (!entry) throw new Error(`no driver registered for ${kind}`);
    entry.instance ??= entry.open().catch((err: unknown) => {
      delete entry.instance; // a failed start must not be cached forever
      throw err;
    });
    return entry.instance;
  }

  /** Every known harness, so the UI can grey out the ones this server cannot drive. */
  async statusAll(refresh = false): Promise<ProviderStatusDto[]> {
    return Promise.all(
      ALL_KINDS.map((kind) =>
        this.has(kind) ? this.status(kind, refresh) : Promise.resolve(unusable(kind, new Error("driver not available in this build"))),
      ),
    );
  }

  async status(kind: ProviderKind, refresh = false): Promise<ProviderStatusDto> {
    const now = this.#now();
    const cached = this.#status.get(kind);
    if (!refresh && cached && now - cached.at < this.#ttl) return cached.dto;
    let dto: ProviderStatusDto;
    try {
      const instance = await this.get(kind);
      dto = toDto(await instance.status());
    } catch (err) {
      this.#env.log(`[provider] status(${kind}) failed`, err);
      dto = unusable(kind, err);
    }
    this.#status.set(kind, { at: now, dto });
    return dto;
  }

  async dispose(): Promise<void> {
    const pending = [...this.#entries.values()].map(async (entry) => {
      if (!entry.instance) return;
      try {
        await (await entry.instance).dispose();
      } catch (err) {
        this.#env.log("[provider] dispose failed", err);
      }
    });
    await Promise.all(pending);
    this.#entries.clear();
    this.#status.clear();
  }
}
