import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AcpRegistryAgent } from "@tide/contracts";
import snapshot from "./acpRegistry.snapshot.json" with { type: "json" };

// The public Agent Client Protocol registry (agentclientprotocol.com): which agents exist and
// how each is launched. Fetched at most once a day, cached under the data dir; the bundled
// snapshot answers when the machine has never been online.

export const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const TTL_MS = 24 * 60 * 60_000;
const CACHE_FILE = "acp-registry.json";

interface PackageDist {
  package: string;
  args?: string[];
  env?: Record<string, string>;
}
interface BinaryTarget {
  archive?: string;
  cmd?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AcpAgentEntry {
  id: string;
  name: string;
  version?: string;
  description?: string;
  repository?: string;
  website?: string;
  authors?: string[];
  license?: string;
  license_url?: string;
  icon?: string;
  distribution: { npx?: PackageDist; uvx?: PackageDist; binary?: Record<string, BinaryTarget> };
}

export interface AcpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The registry's platform key for this machine, e.g. `darwin-aarch64`, `linux-x86_64`, `windows-x86_64`. */
export function platformKey(platform: string = process.platform, arch: string = process.arch): string {
  const os = platform === "win32" ? "windows" : platform;
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch;
  return `${os}-${cpu}`;
}

/** npx first, then uvx, then a prebuilt binary for this platform. */
export function distributionOf(agent: AcpAgentEntry, platform: string = platformKey()): AcpRegistryAgent["distribution"] {
  if (agent.distribution.npx) return "npx";
  if (agent.distribution.uvx) return "uvx";
  if (agent.distribution.binary?.[platform]) return "binary";
  return "none";
}

/**
 * How Tide launches `agent` here. Binary distributions are not launched in v1 (Tide does not
 * download archives): the user installs the agent and configures a manual command instead.
 */
export function resolveLaunch(agent: AcpAgentEntry, platform: string = platformKey()): AcpLaunch | undefined {
  const dist = distributionOf(agent, platform);
  if (dist === "npx" && agent.distribution.npx) {
    const p = agent.distribution.npx;
    return { command: "npx", args: ["-y", p.package, ...(p.args ?? [])], env: { ...p.env } };
  }
  if (dist === "uvx" && agent.distribution.uvx) {
    const p = agent.distribution.uvx;
    return { command: "uvx", args: [p.package, ...(p.args ?? [])], env: { ...p.env } };
  }
  return undefined;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined);
function env(v: unknown): Record<string, string> | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) if (typeof x === "string") out[k] = x;
  return out;
}
function pkg(v: unknown): PackageDist | undefined {
  const r = v as Record<string, unknown> | undefined;
  const name = str(r?.["package"]);
  if (!r || name === undefined) return undefined;
  const args = strings(r["args"]);
  const e = env(r["env"]);
  return { package: name, ...(args ? { args } : {}), ...(e ? { env: e } : {}) };
}

/** Keeps only well-formed entries (and only the fields Tide reads). */
export function parseRegistry(raw: unknown): AcpAgentEntry[] {
  const agents = (raw as { agents?: unknown } | undefined)?.agents;
  if (!Array.isArray(agents)) throw new Error("ACP registry has no agents list");
  const out: AcpAgentEntry[] = [];
  for (const a of agents as Record<string, unknown>[]) {
    const id = str(a?.["id"]);
    const name = str(a?.["name"]);
    const d = a?.["distribution"] as Record<string, unknown> | undefined;
    if (id === undefined || name === undefined || typeof d !== "object" || d === null) continue;
    const npx = pkg(d["npx"]);
    const uvx = pkg(d["uvx"]);
    const binary = typeof d["binary"] === "object" && d["binary"] !== null ? (d["binary"] as Record<string, BinaryTarget>) : undefined;
    const entry: AcpAgentEntry = { id, name, distribution: { ...(npx ? { npx } : {}), ...(uvx ? { uvx } : {}), ...(binary ? { binary } : {}) } };
    for (const key of ["version", "description", "repository", "website", "license", "license_url", "icon"] as const) {
      const v = str(a[key]);
      if (v !== undefined) entry[key] = v;
    }
    const authors = strings(a["authors"]);
    if (authors) entry.authors = authors;
    out.push(entry);
  }
  return out;
}

export interface AcpRegistryOptions {
  /** cache directory; ":memory:" keeps the cache in memory only */
  dataDir: string;
  fetch?: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  now?: () => number;
  ttlMs?: number;
  log?: (msg: string, data?: unknown) => void;
  /** test seam: replaces the bundled snapshot */
  snapshot?: unknown;
}

export class AcpRegistry {
  #dataDir: string;
  #fetch: NonNullable<AcpRegistryOptions["fetch"]>;
  #now: () => number;
  #ttl: number;
  #log: (msg: string, data?: unknown) => void;
  #agents: AcpAgentEntry[];
  #fetchedAt: number | undefined;
  #loading: Promise<void> | undefined;

  constructor(options: AcpRegistryOptions) {
    this.#dataDir = options.dataDir;
    this.#fetch = options.fetch ?? ((url) => fetch(url, { signal: AbortSignal.timeout(15_000) }));
    this.#now = options.now ?? (() => Date.now());
    this.#ttl = options.ttlMs ?? TTL_MS;
    this.#log = options.log ?? (() => undefined);
    const cached = this.#readCache();
    if (cached) {
      this.#agents = cached.agents;
      this.#fetchedAt = cached.fetchedAt;
    } else {
      this.#agents = parseRegistry(options.snapshot ?? snapshot);
    }
  }

  /** What is known right now (cache or snapshot); never touches the network. */
  agents(): AcpAgentEntry[] {
    return this.#agents;
  }

  find(id: string): AcpAgentEntry | undefined {
    return this.#agents.find((a) => a.id === id);
  }

  get fetchedAt(): number | undefined {
    return this.#fetchedAt;
  }

  /** Refetches when the cache is older than the TTL (or always with `refresh`); offline keeps what it has. */
  async load(refresh = false): Promise<AcpAgentEntry[]> {
    const fresh = this.#fetchedAt !== undefined && this.#now() - this.#fetchedAt < this.#ttl;
    if (fresh && !refresh) return this.#agents;
    this.#loading ??= this.#download().finally(() => {
      this.#loading = undefined;
    });
    await this.#loading;
    return this.#agents;
  }

  async #download(): Promise<void> {
    try {
      const res = await this.#fetch(ACP_REGISTRY_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const agents = parseRegistry(await res.json());
      this.#agents = agents;
      this.#fetchedAt = this.#now();
      this.#writeCache();
    } catch (err) {
      this.#log("[acp] registry fetch failed; using the cached list", err instanceof Error ? err.message : err);
    }
  }

  #cachePath(): string | undefined {
    return this.#dataDir === ":memory:" ? undefined : join(this.#dataDir, CACHE_FILE);
  }

  #readCache(): { agents: AcpAgentEntry[]; fetchedAt: number } | undefined {
    const path = this.#cachePath();
    if (path === undefined) return undefined;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { fetchedAt?: unknown };
      if (typeof raw.fetchedAt !== "number") return undefined;
      return { agents: parseRegistry(raw), fetchedAt: raw.fetchedAt };
    } catch {
      return undefined;
    }
  }

  #writeCache(): void {
    const path = this.#cachePath();
    if (path === undefined) return;
    try {
      mkdirSync(this.#dataDir, { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify({ fetchedAt: this.#fetchedAt, agents: this.#agents }));
      renameSync(`${path}.tmp`, path);
    } catch (err) {
      this.#log("[acp] could not cache the registry", err);
    }
  }
}

/** The wire shape for `providers.acpRegistry`. */
export function toRegistryDto(agent: AcpAgentEntry, configured: ReadonlySet<string>, platform: string = platformKey()): AcpRegistryAgent {
  return {
    id: agent.id,
    name: agent.name,
    ...(agent.description !== undefined ? { description: agent.description } : {}),
    ...(agent.version !== undefined ? { version: agent.version } : {}),
    ...(agent.license !== undefined ? { license: agent.license } : {}),
    ...(agent.website ?? agent.repository ? { website: (agent.website ?? agent.repository) as string } : {}),
    ...(agent.icon !== undefined ? { icon: agent.icon } : {}),
    distribution: distributionOf(agent, platform),
    ...(configured.has(agent.id) ? { configured: true } : {}),
  };
}
