import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { newId, type ProviderKind } from "@tide/contracts";

export interface CliFlags {
  port?: number;
  host?: string;
  dev?: boolean;
  data?: string;
  printToken?: boolean;
}

export interface ServerConfig {
  tideHome: string;
  dataDir: string;
  /** ":memory:" is honoured so tests can run without touching the disk */
  dbPath: string;
  environmentId: string;
  token: string;
  host: string;
  port: number;
  dev: boolean;
  printToken: boolean;
  corsOrigins: string[];
  version: string;
  /** per-driver config from `<TIDE_HOME>/server.json` → `providers: { claude: {...} }` */
  providers: ProviderConfigs;
}

export type ProviderConfigs = Partial<Record<ProviderKind, Record<string, unknown>>>;

export function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${String(arg)}`);
      return v;
    };
    switch (arg) {
      case "--port":
        flags.port = Number(next());
        break;
      case "--host":
        flags.host = next();
        break;
      case "--data":
        flags.data = next();
        break;
      case "--dev":
        flags.dev = true;
        break;
      case "--print-token":
        flags.printToken = true;
        break;
      default:
        if (arg !== undefined && arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
    }
  }
  return flags;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(import.meta.dirname), "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

interface ServerIdentity {
  environmentId: string;
  token: string;
  providers: ProviderConfigs;
}

const PROVIDER_KINDS: readonly ProviderKind[] = ["claude", "codex", "opencode", "pi"];

function readProviders(value: unknown): ProviderConfigs {
  if (typeof value !== "object" || value === null) return {};
  const raw = value as Record<string, unknown>;
  const out: ProviderConfigs = {};
  for (const kind of PROVIDER_KINDS) {
    const entry = raw[kind];
    if (typeof entry === "object" && entry !== null) out[kind] = entry as Record<string, unknown>;
  }
  return out;
}

/** Reads (or creates, 0600) `<TIDE_HOME>/server.json`: identity, bearer token, driver config. */
function loadIdentity(tideHome: string): ServerIdentity {
  const file = join(tideHome, "server.json");
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (typeof parsed["environmentId"] === "string" && typeof parsed["token"] === "string") {
        return {
          environmentId: parsed["environmentId"],
          token: parsed["token"],
          providers: readProviders(parsed["providers"]),
        };
      }
    } catch {
      /* fall through and rewrite a fresh identity */
    }
  }
  const identity: ServerIdentity = { environmentId: newId(), token: randomBytes(32).toString("hex"), providers: {} };
  writeFileSync(file, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  return identity;
}

export function resolveConfig(argv: string[] = [], env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const flags = parseArgs(argv);
  const tideHome = resolve(env["TIDE_HOME"] ?? join(homedir(), ".tide"));
  mkdirSync(tideHome, { recursive: true, mode: 0o700 });

  const dataOverride = flags.data;
  const isMemory = dataOverride === ":memory:";
  const dataDir = isMemory ? ":memory:" : resolve(dataOverride ?? join(tideHome, "data"));
  if (!isMemory) mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const identity = loadIdentity(tideHome);
  const dev = flags.dev ?? false;
  const extraOrigins = (env["TIDE_CORS_ORIGINS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  return {
    tideHome,
    dataDir,
    dbPath: isMemory ? ":memory:" : join(dataDir, "events.sqlite"),
    environmentId: identity.environmentId,
    token: identity.token,
    host: flags.host ?? "127.0.0.1",
    port: flags.port ?? 3777,
    dev,
    printToken: flags.printToken ?? false,
    corsOrigins: [...(dev ? ["http://localhost:5173"] : []), ...extraOrigins],
    version: readVersion(),
    providers: identity.providers,
  };
}
