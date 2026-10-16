import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ProviderKind, Team, type DecisionSites, type DecisionsSettings, type UserSettings, type UserSettingsPatch } from "@tide/contracts";
import { Check } from "typebox/value";
import { JEV_CONTEXT_TOKENS, USD_PER_MILLION_INPUT_TOKENS } from "./decisions/client.ts";
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from "./decisions/wire.ts";
import { presetTeams } from "./teams/presets.ts";

/**
 * User settings every client must agree on: provider defaults, worktree default, follow-up and
 * usage-limit defaults, the optional decisions model. Kept in `<TIDE_HOME>/settings.json` (0600 — it may hold the TypeSafe key).
 * The key is never returned over RPC; `decisions.hasKey` says whether one is stored.
 */
interface StoredSettings {
  providerDefaults: UserSettings["providerDefaults"];
  worktreeByDefault: boolean;
  decisions: StoredDecisions;
  continueAfterRestart?: boolean;
  followUpMode?: UserSettings["followUpMode"];
  limitPolicy?: UserSettings["limitPolicy"];
  /** the user's saved teams; empty = show the presets */
  teams?: Team[];
}

interface StoredDecisions {
  enabled: boolean;
  apiKey?: string;
  fallback?: NonNullable<DecisionsSettings["fallback"]>;
  grayZone?: DecisionsSettings["grayZone"];
  sites?: Partial<DecisionSites>;
  expertsAutoAdvance?: boolean;
}

export const DEFAULT_GRAY_ZONE: DecisionsSettings["grayZone"] = { low: 0.6, high: 0.85 };
export const DEFAULT_SITES: DecisionSites = { handoff: true, experts: true, delegates: true, approvals: true, stuck: true };

/** `settings.set` refused the patch (duplicate team ids); the RPC layer maps it to `invalid-params`. */
export class SettingsError extends Error {}

function assertGrayZone(z: { low: number; high: number }): void {
  if (!(Number.isFinite(z.low) && Number.isFinite(z.high) && z.low >= 0 && z.low < z.high && z.high <= 1)) {
    throw new SettingsError(`grayZone must satisfy 0 ≤ low < high ≤ 1 (got ${z.low}, ${z.high})`);
  }
}

function decisionsDto(d: StoredDecisions): DecisionsSettings {
  return {
    enabled: d.enabled,
    hasKey: typeof d.apiKey === "string" && d.apiKey.length > 0,
    model: DEFAULT_MODEL,
    endpoint: DEFAULT_BASE_URL,
    usdPerMillionInput: USD_PER_MILLION_INPUT_TOKENS,
    contextTokens: JEV_CONTEXT_TOKENS,
    ...(d.fallback !== undefined ? { fallback: { ...d.fallback } } : {}),
    grayZone: { ...(d.grayZone ?? DEFAULT_GRAY_ZONE) },
    sites: { ...DEFAULT_SITES, ...d.sites },
    expertsAutoAdvance: d.expertsAutoAdvance ?? false,
  };
}

/** Loads the stored decisions block, dropping anything malformed. */
function loadDecisions(raw: unknown): StoredDecisions {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const out: StoredDecisions = { enabled: r["enabled"] === true };
  if (typeof r["apiKey"] === "string") out.apiKey = r["apiKey"];
  const fb = r["fallback"] as { provider?: unknown; model?: unknown } | undefined;
  if (typeof fb === "object" && fb !== null && Check(ProviderKind, fb.provider)) {
    out.fallback = { provider: fb.provider, ...(typeof fb.model === "string" ? { model: fb.model } : {}) };
  }
  const gz = r["grayZone"] as { low?: unknown; high?: unknown } | undefined;
  if (typeof gz === "object" && gz !== null && typeof gz.low === "number" && typeof gz.high === "number") {
    try {
      assertGrayZone({ low: gz.low, high: gz.high });
      out.grayZone = { low: gz.low, high: gz.high };
    } catch {
      /* out of range: defaults */
    }
  }
  const sites = r["sites"];
  if (typeof sites === "object" && sites !== null) {
    const picked: Partial<DecisionSites> = {};
    for (const key of Object.keys(DEFAULT_SITES) as (keyof DecisionSites)[]) {
      const v = (sites as Record<string, unknown>)[key];
      if (typeof v === "boolean") picked[key] = v;
    }
    out.sites = picked;
  }
  if (typeof r["expertsAutoAdvance"] === "boolean") out.expertsAutoAdvance = r["expertsAutoAdvance"];
  return out;
}

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
      decisions: decisionsDto(decisions),
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
    if (patch.decisions?.grayZone !== undefined) assertGrayZone(patch.decisions.grayZone);
    const next: StoredSettings = {
      providerDefaults: patch.providerDefaults ?? this.#state.providerDefaults,
      worktreeByDefault: patch.worktreeByDefault ?? this.#state.worktreeByDefault,
      decisions: structuredClone(this.#state.decisions),
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
    const d = patch.decisions;
    if (d?.fallback === null) delete next.decisions.fallback;
    else if (d?.fallback !== undefined) next.decisions.fallback = { provider: d.fallback.provider, ...(d.fallback.model !== undefined ? { model: d.fallback.model } : {}) };
    if (d?.grayZone !== undefined) next.decisions.grayZone = { low: d.grayZone.low, high: d.grayZone.high };
    if (d?.sites !== undefined) {
      const sites: Partial<DecisionSites> = { ...next.decisions.sites };
      for (const [key, value] of Object.entries(d.sites)) if (typeof value === "boolean") sites[key as keyof DecisionSites] = value;
      next.decisions.sites = sites;
    }
    if (d?.expertsAutoAdvance !== undefined) next.decisions.expertsAutoAdvance = d.expertsAutoAdvance;
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
      decisions: loadDecisions(r.decisions),
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
