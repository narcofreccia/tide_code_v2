import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { ProviderInstanceConfig, ProviderKind, Team, type DecisionSites, type DecisionsSettings, type GitSettings, InboxSettings, type UserSettings, type UserSettingsPatch } from "@tide/contracts";
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
  inbox?: Partial<InboxSettings>;
  /** R12 */
  git?: Partial<GitSettings>;
  textModel?: NonNullable<UserSettings["textModel"]>;
  /** R8: user-added harness instances; the bundled defaults are implicit */
  providerInstances?: ProviderInstanceConfig[];
  /** R9: this machine's name / ssh host as other clients see it */
  environment?: { name?: string; sshHost?: string };
  /** R9: self-hosted relay this server dials out to; the key stays here, never on the wire */
  relay?: { url: string; key?: string };
  /** R10 */
  glassBox?: Partial<UserSettings["glassBox"]>;
  /** R11 */
  keybindings?: Record<string, string>;
}

const DEFAULT_GIT: GitSettings = { mergeStrategy: "squash", deleteBranchOnMerge: true, confirmMergeBack: true };

function loadGit(raw: unknown): Partial<GitSettings> {
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as Record<string, unknown>;
  return {
    ...(r.mergeStrategy === "merge" || r.mergeStrategy === "squash" || r.mergeStrategy === "rebase" ? { mergeStrategy: r.mergeStrategy } : {}),
    ...(typeof r.deleteBranchOnMerge === "boolean" ? { deleteBranchOnMerge: r.deleteBranchOnMerge } : {}),
    ...(typeof r.confirmMergeBack === "boolean" ? { confirmMergeBack: r.confirmMergeBack } : {}),
  };
}

const DEFAULT_GLASS_BOX: UserSettings["glassBox"] = { limitsInStatusBar: true, readHarnessLogs: true };

const BUNDLED_KINDS: readonly string[] = ["claude", "codex", "opencode", "pi"];

/** ids unique, never a bundled kind's own id, kind-specific launch info present. */
function assertProviderInstances(list: ProviderInstanceConfig[]): void {
  const seen = new Set<string>();
  for (const inst of list) {
    if (seen.has(inst.id)) throw new SettingsError(`duplicate provider instance id ${inst.id}`);
    if (BUNDLED_KINDS.includes(inst.id)) throw new SettingsError(`${inst.id} is a bundled harness; add a second account under another id`);
    if (inst.kind === "acp" && inst.acpAgentId === undefined && inst.command === undefined) {
      throw new SettingsError(`ACP instance ${inst.id} needs a registry agent or a command`);
    }
    seen.add(inst.id);
  }
}

export const DEFAULT_INBOX: InboxSettings = { autoSettleAfterDays: 3, autoSettleOnMerge: true, workingSection: false };

function loadInbox(raw: unknown): Partial<InboxSettings> {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const out: Partial<InboxSettings> = {};
  if (typeof r["autoSettleAfterDays"] === "number" && r["autoSettleAfterDays"] >= 0) out.autoSettleAfterDays = r["autoSettleAfterDays"];
  if (typeof r["autoSettleOnMerge"] === "boolean") out.autoSettleOnMerge = r["autoSettleOnMerge"];
  if (typeof r["workingSection"] === "boolean") out.workingSection = r["workingSection"];
  return out;
}

function loadTextModel(raw: unknown): NonNullable<UserSettings["textModel"]> | undefined {
  const r = raw as { provider?: unknown; model?: unknown } | undefined;
  if (typeof r !== "object" || r === null || !Check(ProviderKind, r.provider)) return undefined;
  return { provider: r.provider, ...(typeof r.model === "string" ? { model: r.model } : {}) };
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
    const { decisions, continueAfterRestart, followUpMode, limitPolicy, teams, inbox, git, textModel, providerInstances, environment, relay, glassBox, keybindings, ...rest } = this.#state;
    return {
      ...rest,
      keybindings: { ...(keybindings ?? {}) },
      glassBox: { ...DEFAULT_GLASS_BOX, ...glassBox },
      environment: { name: environment?.name ?? hostname(), ...(environment?.sshHost !== undefined ? { sshHost: environment.sshHost } : {}) },
      ...(relay !== undefined ? { relay: { url: relay.url, hasKey: typeof relay.key === "string" && relay.key.length > 0 } } : {}),
      inbox: { ...DEFAULT_INBOX, ...inbox },
      git: { ...DEFAULT_GIT, ...git },
      providerInstances: structuredClone(providerInstances ?? []),
      ...(textModel !== undefined ? { textModel: { ...textModel } } : {}),
      decisions: decisionsDto(decisions),
      continueAfterRestart: continueAfterRestart ?? false,
      followUpMode: followUpMode ?? "steer",
      limitPolicy: limitPolicy ?? "manual",
      // the presets stand in until the user saves a team of their own
      teams: teams !== undefined && teams.length > 0 ? structuredClone(teams) : presetTeams(),
    };
  }

  /** R9: relay url + key for the server-side relay client only. */
  relayConfig(): { url: string; key?: string } | undefined {
    return this.#state.relay === undefined ? undefined : { ...this.#state.relay };
  }

  /** The stored key, for the server-side decisions client only. */
  decisionsApiKey(): string | undefined {
    return this.#state.decisions.apiKey;
  }

  set(patch: UserSettingsPatch): UserSettings {
    if (patch.teams !== undefined) assertUniqueTeamIds(patch.teams);
    if (patch.decisions?.grayZone !== undefined) assertGrayZone(patch.decisions.grayZone);
    if (patch.providerInstances !== undefined) assertProviderInstances(patch.providerInstances);
    if (patch.inbox?.autoSettleAfterDays !== undefined && !(Number.isFinite(patch.inbox.autoSettleAfterDays) && patch.inbox.autoSettleAfterDays >= 0)) {
      throw new SettingsError(`inbox.autoSettleAfterDays must be ≥ 0 (got ${patch.inbox.autoSettleAfterDays})`);
    }
    const next: StoredSettings = {
      providerDefaults: patch.providerDefaults ?? this.#state.providerDefaults,
      worktreeByDefault: patch.worktreeByDefault ?? this.#state.worktreeByDefault,
      decisions: structuredClone(this.#state.decisions),
      continueAfterRestart: patch.continueAfterRestart ?? this.#state.continueAfterRestart ?? false,
      followUpMode: patch.followUpMode ?? this.#state.followUpMode ?? "steer",
      limitPolicy: patch.limitPolicy ?? this.#state.limitPolicy ?? "manual",
      teams: patch.teams !== undefined ? structuredClone(patch.teams) : (this.#state.teams ?? []),
      inbox: { ...this.#state.inbox, ...loadInbox(patch.inbox) },
      git: { ...this.#state.git, ...loadGit(patch.git) },
      providerInstances: patch.providerInstances !== undefined ? structuredClone(patch.providerInstances) : (this.#state.providerInstances ?? []),
      ...(this.#state.environment !== undefined ? { environment: { ...this.#state.environment } } : {}),
      ...(this.#state.relay !== undefined ? { relay: { ...this.#state.relay } } : {}),
      keybindings: patch.keybindings !== undefined ? Object.fromEntries(Object.entries(patch.keybindings).filter(([, v]) => v !== "")) : { ...(this.#state.keybindings ?? {}) },
      glassBox: { ...this.#state.glassBox, ...(patch.glassBox?.limitsInStatusBar !== undefined ? { limitsInStatusBar: patch.glassBox.limitsInStatusBar } : {}), ...(patch.glassBox?.readHarnessLogs !== undefined ? { readHarnessLogs: patch.glassBox.readHarnessLogs } : {}) },
      ...(this.#state.textModel !== undefined ? { textModel: this.#state.textModel } : {}),
    };
    if (patch.environment !== undefined) {
      const env = { ...(next.environment ?? {}) };
      if (patch.environment.name !== undefined) env.name = patch.environment.name.trim();
      if (patch.environment.sshHost === null) delete env.sshHost;
      else if (patch.environment.sshHost !== undefined) env.sshHost = patch.environment.sshHost.trim();
      next.environment = env;
    }
    if (patch.relay === null) delete next.relay;
    else if (patch.relay !== undefined) {
      const key = patch.relay.key ?? (next.relay?.url === patch.relay.url ? next.relay?.key : undefined);
      next.relay = { url: patch.relay.url.trim(), ...(key !== undefined && key.length > 0 ? { key } : {}) };
    }
    if (patch.textModel === null) delete next.textModel;
    else if (patch.textModel !== undefined) next.textModel = { provider: patch.textModel.provider, ...(patch.textModel.model !== undefined ? { model: patch.textModel.model } : {}) };
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
    const textModel = loadTextModel(r.textModel);
    return {
      providerDefaults: typeof r.providerDefaults === "object" && r.providerDefaults !== null ? r.providerDefaults : {},
      worktreeByDefault: typeof r.worktreeByDefault === "boolean" ? r.worktreeByDefault : DEFAULTS.worktreeByDefault,
      decisions: loadDecisions(r.decisions),
      continueAfterRestart: r.continueAfterRestart === true,
      followUpMode: r.followUpMode === "queue" ? "queue" : "steer",
      limitPolicy: r.limitPolicy === "reset" ? "reset" : "manual",
      teams: Array.isArray(r.teams) ? r.teams.filter((t): t is Team => Check(Team, t)) : [],
      inbox: loadInbox(r.inbox),
      git: loadGit(r.git),
      ...(textModel !== undefined ? { textModel } : {}),
      providerInstances: Array.isArray(r.providerInstances) ? r.providerInstances.filter((p): p is ProviderInstanceConfig => Check(ProviderInstanceConfig, p)) : [],
      ...(typeof r.environment === "object" && r.environment !== null ? { environment: {
        ...(typeof r.environment.name === "string" ? { name: r.environment.name } : {}),
        ...(typeof r.environment.sshHost === "string" ? { sshHost: r.environment.sshHost } : {}),
      } } : {}),
      ...(typeof r.relay === "object" && r.relay !== null && typeof r.relay.url === "string" ? { relay: { url: r.relay.url, ...(typeof r.relay.key === "string" ? { key: r.relay.key } : {}) } } : {}),
      ...(typeof r.keybindings === "object" && r.keybindings !== null ? { keybindings: Object.fromEntries(Object.entries(r.keybindings).filter(([, v]) => typeof v === "string" && v !== "")) as Record<string, string> } : {}),
      glassBox: {
        ...(typeof r.glassBox?.limitsInStatusBar === "boolean" ? { limitsInStatusBar: r.glassBox.limitsInStatusBar } : {}),
        ...(typeof r.glassBox?.readHarnessLogs === "boolean" ? { readHarnessLogs: r.glassBox.readHarnessLogs } : {}),
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
