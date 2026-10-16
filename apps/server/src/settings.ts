import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Team, type UserSettings, type UserSettingsPatch } from "@tide/contracts";
import { Check } from "typebox/value";
import { presetTeams } from "./teams/presets.ts";

/**
 * User settings every client must agree on: provider defaults, worktree default, follow-up and
 * usage-limit defaults, the optional decisions model. Kept in `<TIDE_HOME>/settings.json` (0600 — it may hold the TypeSafe key).
 * The key is never returned over RPC; `decisions.hasKey` says whether one is stored.
 */
interface StoredSettings {
  providerDefaults: UserSettings["providerDefaults"];
  worktreeByDefault: boolean;
  decisions: { enabled: boolean; apiKey?: string };
  continueAfterRestart?: boolean;
  followUpMode?: UserSettings["followUpMode"];
  limitPolicy?: UserSettings["limitPolicy"];
  /** the user's saved teams; empty = show the presets */
  teams?: Team[];
}

/** `settings.set` refused the patch (duplicate team ids); the RPC layer maps it to `invalid-params`. */
export class SettingsError extends Error {}

function assertUniqueTeamIds(teams: Team[]): void {
  const seen = new Set<string>();
  for (const team of teams) {
    if (seen.has(team.id)) throw new SettingsError(`duplicate team id ${team.id}`);
    seen.add(team.id);
  }
}

const DEFAULTS: StoredSettings = {
  providerDefaults: {},
  worktreeByDefault: true,
  decisions: { enabled: false },
  continueAfterRestart: false,
  followUpMode: "steer",
  limitPolicy: "manual",
  teams: [],
};

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
    const { decisions, continueAfterRestart, followUpMode, limitPolicy, teams, ...rest } = this.#state;
    return {
      ...rest,
      decisions: { enabled: decisions.enabled, hasKey: typeof decisions.apiKey === "string" && decisions.apiKey.length > 0 },
      continueAfterRestart: continueAfterRestart ?? false,
      followUpMode: followUpMode ?? "steer",
      limitPolicy: limitPolicy ?? "manual",
      // the presets stand in until the user saves a team of their own
      teams: teams !== undefined && teams.length > 0 ? structuredClone(teams) : presetTeams(),
    };
  }

  /** The stored key, for the server-side decisions client only. */
  decisionsApiKey(): string | undefined {
    return this.#state.decisions.apiKey;
  }

  set(patch: UserSettingsPatch): UserSettings {
    if (patch.teams !== undefined) assertUniqueTeamIds(patch.teams);
    const next: StoredSettings = {
      providerDefaults: patch.providerDefaults ?? this.#state.providerDefaults,
      worktreeByDefault: patch.worktreeByDefault ?? this.#state.worktreeByDefault,
      decisions: { ...this.#state.decisions },
      continueAfterRestart: patch.continueAfterRestart ?? this.#state.continueAfterRestart ?? false,
      followUpMode: patch.followUpMode ?? this.#state.followUpMode ?? "steer",
      limitPolicy: patch.limitPolicy ?? this.#state.limitPolicy ?? "manual",
      teams: patch.teams !== undefined ? structuredClone(patch.teams) : (this.#state.teams ?? []),
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
      continueAfterRestart: r.continueAfterRestart === true,
      followUpMode: r.followUpMode === "queue" ? "queue" : "steer",
      limitPolicy: r.limitPolicy === "reset" ? "reset" : "manual",
      teams: Array.isArray(r.teams) ? r.teams.filter((t): t is Team => Check(Team, t)) : [],
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
