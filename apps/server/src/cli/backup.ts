import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { openDatabase } from "../db/sqlite.ts";

/**
 * `tide backup`: one tar.gz of what a machine cannot rebuild: the event store (a `VACUUM INTO`
 * snapshot, consistent while the server runs), settings.json (API keys stripped unless asked)
 * and uploads/. Identity and pairings (server.json, clients.json), secrets/, logs/, worktrees/,
 * shell.json, the lock and the caches under data/ are never in it.
 */

export const BACKUP_FORMAT = "tide-backup";
export const BACKUP_FORMAT_VERSION = 1;
export const MANIFEST = "manifest.json";
/** Paths inside the archive mirror TIDE_HOME. */
export const DB_ENTRY = "data/events.sqlite";
export const SETTINGS_ENTRY = "settings.json";
export const UPLOADS_ENTRY = "uploads";

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  tideVersion: string;
  /** `PRAGMA user_version` of the snapshot (0 = the store did not record one) */
  dbUserVersion: number;
  environmentName: string;
  createdAt: string;
  /** false: settings.json was written with the fields in `strippedKeys` removed */
  keysIncluded: boolean;
  strippedKeys: string[];
  files: ManifestFile[];
}

export interface BackupDeps {
  tideHome: string;
  version: string;
  cwd?: string;
  now?: () => Date;
  log: (line: string) => void;
}

export const dbPathOf = (tideHome: string): string => join(tideHome, "data", "events.sqlite");

const pad = (n: number): string => String(n).padStart(2, "0");
/** `YYYYMMDD-HHmmss` in local time. */
export const stamp = (d: Date): string =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

export function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Files under `dir`, as archive paths relative to `root` with `/` separators. */
export function listFiles(root: string, dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(root, full));
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join("/"));
  }
  return out.sort();
}

/** `tar` ships with macOS, Linux and Windows 10+ (bsdtar as tar.exe); `tide update` relies on it too. */
export function tar(args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    execFile("tar", args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err === null) done();
      else fail(new Error(`tar ${args[0] ?? ""} failed: ${`${stderr}${stdout}`.trim() || err.message}`));
    });
  });
}

/** settings.json without its secrets: the decisions key, the relay key, every provider instance's env. */
export function stripKeys(settings: Record<string, unknown>): { settings: Record<string, unknown>; stripped: string[] } {
  const out = structuredClone(settings);
  const stripped: string[] = [];
  const decisions = out["decisions"];
  if (typeof decisions === "object" && decisions !== null && "apiKey" in decisions) {
    delete (decisions as Record<string, unknown>)["apiKey"];
    stripped.push("decisions.apiKey");
  }
  const relay = out["relay"];
  if (typeof relay === "object" && relay !== null && "key" in relay) {
    delete (relay as Record<string, unknown>)["key"];
    stripped.push("relay.key");
  }
  const instances = out["providerInstances"];
  if (Array.isArray(instances)) {
    for (const inst of instances as unknown[]) {
      if (typeof inst !== "object" || inst === null) continue;
      const r = inst as Record<string, unknown>;
      if (typeof r["env"] !== "object" || r["env"] === null) continue;
      const names = Object.keys(r["env"] as Record<string, unknown>);
      delete r["env"];
      if (names.length > 0) stripped.push(`providerInstances[${String(r["id"])}].env (${names.join(", ")})`);
    }
  }
  return { settings: out, stripped };
}

function environmentName(settings: Record<string, unknown> | undefined): string {
  const env = settings?.["environment"];
  const name = typeof env === "object" && env !== null ? (env as Record<string, unknown>)["name"] : undefined;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : hostname();
}

const fileSafe = (name: string): string => name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "tide";

/** A consistent copy of a live WAL database. The snapshot's `user_version` comes back. */
async function snapshotDb(source: string, target: string): Promise<number> {
  const db = await openDatabase(source);
  try {
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
    const row = db.prepare("PRAGMA user_version").get();
    return Number(row?.["user_version"] ?? 0);
  } finally {
    db.close();
  }
}

/** Returns the exit code; every line goes through `deps.log`. */
export async function runBackup(opts: { out?: string; includeKeys: boolean }, deps: BackupDeps): Promise<number> {
  const { tideHome, log } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const dbPath = dbPathOf(tideHome);
  if (!existsSync(dbPath)) {
    log(`tide backup: no database at ${dbPath}; nothing to back up (is TIDE_HOME right?)`);
    return 1;
  }
  const settingsFile = join(tideHome, SETTINGS_ENTRY);
  let settings: Record<string, unknown> | undefined;
  if (existsSync(settingsFile)) {
    try {
      settings = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
    } catch (err) {
      log(`tide backup: ${settingsFile} is not valid JSON (${err instanceof Error ? err.message : String(err)}); fix it first`);
      return 1;
    }
  }
  const envName = environmentName(settings);
  const out = resolve(deps.cwd ?? process.cwd(), opts.out ?? `tide-backup-${fileSafe(envName)}-${stamp(now)}.tar.gz`);
  if (existsSync(out)) {
    log(`tide backup: ${out} already exists; pick another --out`);
    return 1;
  }

  const staging = mkdtempSync(join(tmpdir(), "tide-backup-"));
  try {
    mkdirSync(join(staging, "data"));
    const dbUserVersion = await snapshotDb(dbPath, join(staging, DB_ENTRY));
    let stripped: string[] = [];
    if (settings !== undefined) {
      let body = settings;
      if (!opts.includeKeys) ({ settings: body, stripped } = stripKeys(settings));
      writeFileSync(join(staging, SETTINGS_ENTRY), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    }
    const uploads = join(tideHome, UPLOADS_ENTRY);
    for (const path of listFiles(tideHome, uploads)) {
      mkdirSync(join(staging, ...path.split("/").slice(0, -1)), { recursive: true });
      copyFileSync(join(tideHome, ...path.split("/")), join(staging, ...path.split("/")));
    }

    const entries = listFiles(staging, staging);
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      tideVersion: deps.version,
      dbUserVersion,
      environmentName: envName,
      createdAt: now.toISOString(),
      keysIncluded: opts.includeKeys,
      strippedKeys: stripped,
      files: entries.map((path) => {
        const full = join(staging, ...path.split("/"));
        return { path, size: statSync(full).size, sha256: sha256File(full) };
      }),
    };
    writeFileSync(join(staging, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    const top = [MANIFEST, ...new Set(entries.map((p) => p.split("/")[0] as string))];
    await tar(["-czf", out, "-C", staging, ...top]);

    log(`wrote ${out}`);
    for (const f of manifest.files) log(`  ${f.path} (${f.size} bytes)`);
    log("not included: server.json and clients.json (identity and paired devices stay with this machine), secrets/, logs/, worktrees/, shell.json, caches.");
    if (opts.includeKeys) log("warning: settings.json keeps its API keys (--include-keys); store this archive like a password.");
    else if (stripped.length > 0) log(`settings.json was written without its keys: ${stripped.join("; ")}. Re-enter them after a restore, or back up with --include-keys.`);
    return 0;
  } catch (err) {
    rmSync(out, { force: true });
    log(`tide backup failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
