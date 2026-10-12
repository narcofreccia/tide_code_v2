import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { UserSettings, UserSettingsPatch } from "@tide/contracts";

/**
 * User settings every client must agree on: provider defaults, worktree default, the optional
 * decisions model. Kept in `<TIDE_HOME>/settings.json` (0600 — it may hold the TypeSafe key).
 * The key is never returned over RPC; `decisions.hasKey` says whether one is stored.
 */
interface StoredSettings {
  providerDefaults: UserSettings["providerDefaults"];
  worktreeByDefault: boolean;
  decisions: { enabled: boolean; apiKey?: string };
}

const DEFAULTS: StoredSettings = { providerDefaults: {}, worktreeByDefault: true, decisions: { enabled: false } };

export interface SettingsStoreOptions {
  /** absolute path of settings.json; undefined = in-memory only (tests, `:memory:` data dirs) */
  path?: string;
  log?: (msg: string, data?: unknown) => void;
}

export class SettingsStore {
  #path: string | undefined;
  #log: (msg: string, data?: unknown) => void;
  #state: StoredSettings;

  constructor(options: SettingsStoreOptions = {}) {
    this.#path = options.path;
    this.#log = options.log ?? (() => undefined);
    this.#state = this.#load();
  }

  static pathFor(tideHome: string): string {
    return join(tideHome, "settings.json");
  }

  get(): UserSettings {
    const { decisions, ...rest } = this.#state;
    return { ...rest, decisions: { enabled: decisions.enabled, hasKey: typeof decisions.apiKey === "string" && decisions.apiKey.length > 0 } };
  }

  /** The stored key, for the server-side decisions client only. */
  decisionsApiKey(): string | undefined {
    return this.#state.decisions.apiKey;
  }

  set(patch: UserSettingsPatch): UserSettings {
    const next: StoredSettings = {
      providerDefaults: patch.providerDefaults ?? this.#state.providerDefaults,
      worktreeByDefault: patch.worktreeByDefault ?? this.#state.worktreeByDefault,
      decisions: { ...this.#state.decisions },
    };
    if (patch.decisions?.enabled !== undefined) next.decisions.enabled = patch.decisions.enabled;
    if (patch.decisions?.apiKey !== undefined) {
      // an empty string clears the key
      if (patch.decisions.apiKey.length === 0) delete next.decisions.apiKey;
      else next.decisions.apiKey = patch.decisions.apiKey;
    }
    this.#state = next;
    this.#save();
    return this.get();
  }

  #load(): StoredSettings {
    if (this.#path === undefined) return structuredClone(DEFAULTS);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.#path, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.#log("[settings] unreadable settings.json, using defaults", err);
      return structuredClone(DEFAULTS);
    }
    const r = (raw ?? {}) as Partial<StoredSettings>;
    return {
      providerDefaults: typeof r.providerDefaults === "object" && r.providerDefaults !== null ? r.providerDefaults : {},
      worktreeByDefault: typeof r.worktreeByDefault === "boolean" ? r.worktreeByDefault : DEFAULTS.worktreeByDefault,
      decisions: {
        enabled: r.decisions?.enabled === true,
        ...(typeof r.decisions?.apiKey === "string" ? { apiKey: r.decisions.apiKey } : {}),
      },
    };
  }

  #save(): void {
    if (this.#path === undefined) return;
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.#state, null, 2), { mode: 0o600 });
      renameSync(tmp, this.#path);
    } catch (err) {
      this.#log("[settings] could not persist settings.json", err);
    }
  }
}
