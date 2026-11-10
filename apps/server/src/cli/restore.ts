import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/sqlite.ts";
import { hostLockProbes, readLock, type LockProbes } from "../homeLock.ts";
import { EventStore } from "../orchestration/store.ts";
import { BACKUP_FORMAT, DB_ENTRY, MANIFEST, SETTINGS_ENTRY, UPLOADS_ENTRY, dbPathOf, sha256File, stamp, tar, type BackupManifest, type ManifestFile } from "./backup.ts";

/**
 * `tide restore <archive> [--force]`: puts a `tide backup` archive back into TIDE_HOME. The
 * current database, settings.json and uploads/ move to `pre-restore-<time>/` first; server.json
 * and clients.json are never touched, so this machine keeps its identity and paired devices.
 */

export interface RestoreDeps {
  tideHome: string;
  now?: () => Date;
  probes?: LockProbes;
  /** the newest store schema this build opens; undefined = look it up from a fresh store */
  supportedDbVersion?: number;
  log: (line: string) => void;
}

class RestoreRefused extends Error {}

/**
 * The newest store schema this build opens: an exported schema constant of the store when there
 * is one, else the `user_version` a fresh store gets (0 = the store records none).
 */
export async function supportedDbVersion(): Promise<number> {
  const mod = (await import("../orchestration/store.ts")) as Record<string, unknown>;
  for (const name of ["SCHEMA_VERSION", "STORE_SCHEMA_VERSION", "DB_SCHEMA_VERSION", "USER_VERSION"]) {
    if (typeof mod[name] === "number") return mod[name];
  }
  const db = await openDatabase(":memory:");
  try {
    new EventStore(db);
    return Number(db.prepare("PRAGMA user_version").get()?.["user_version"] ?? 0);
  } finally {
    try {
      db.close();
    } catch {
      /* the store may own the handle */
    }
  }
}

function environmentIdOf(tideHome: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(tideHome, "server.json"), "utf8")) as { environmentId?: unknown };
    return typeof raw.environmentId === "string" ? raw.environmentId : undefined;
  } catch {
    return undefined;
  }
}

/** Same rule as a starting server: the lock counts while its pid lives and its port answers for this home. */
async function serverHolds(tideHome: string, probes: LockProbes): Promise<string | undefined> {
  const holder = readLock(tideHome);
  if (holder === undefined || holder.pid === process.pid || !probes.alive(holder.pid)) return undefined;
  const reported = await probes.health(holder.port);
  if (reported === undefined) return undefined;
  const mine = environmentIdOf(tideHome);
  if (reported !== mine && reported !== holder.environmentId) return undefined;
  return `a Tide server (pid ${holder.pid}, port ${holder.port}) is running on TIDE_HOME=${tideHome}; stop it (quit the app, \`tide service uninstall\` or Ctrl-C) and run tide restore again`;
}

/** Events in the home's current database; a database that cannot be read counts as non-empty. */
async function eventCount(dbPath: string): Promise<number> {
  if (!existsSync(dbPath)) return 0;
  const db = await openDatabase(dbPath);
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'").get();
    if (table === undefined) return 0;
    return Number(db.prepare("SELECT COUNT(*) AS n FROM events").get()?.["n"] ?? 0);
  } catch {
    return Number.POSITIVE_INFINITY;
  } finally {
    db.close();
  }
}

const SAFE_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

function parseManifest(raw: unknown): BackupManifest {
  const m = raw as Partial<BackupManifest> | null;
  if (typeof m !== "object" || m === null || m.format !== BACKUP_FORMAT || !Array.isArray(m.files)) throw new RestoreRefused("this is not a tide backup archive (no valid manifest.json)");
  for (const f of m.files as Partial<ManifestFile>[]) {
    const path = f.path;
    if (typeof path !== "string" || !SAFE_PATH.test(path) || path.split("/").some((s) => s === "." || s === "..")) throw new RestoreRefused(`manifest.json lists an unsafe path ${JSON.stringify(path)}`);
    if (path !== DB_ENTRY && path !== SETTINGS_ENTRY && !path.startsWith(`${UPLOADS_ENTRY}/`)) throw new RestoreRefused(`manifest.json lists ${path}, which a backup never contains`);
    if (typeof f.sha256 !== "string" || typeof f.size !== "number") throw new RestoreRefused(`manifest.json has no checksum for ${path}`);
  }
  if (!m.files.some((f) => f.path === DB_ENTRY)) throw new RestoreRefused("the archive has no database");
  return m as BackupManifest;
}

function verify(dir: string, manifest: BackupManifest): void {
  for (const f of manifest.files) {
    const full = join(dir, ...f.path.split("/"));
    if (!existsSync(full) || !lstatSync(full).isFile()) throw new RestoreRefused(`the archive is missing ${f.path}`);
    if (sha256File(full) !== f.sha256) throw new RestoreRefused(`checksum mismatch for ${f.path}: the archive is damaged or was changed`);
  }
}

/** Returns the exit code; every line goes through `deps.log`. */
export async function runRestore(opts: { archive: string; force: boolean }, deps: RestoreDeps): Promise<number> {
  const { tideHome, log } = deps;
  const staging = mkdtempSync(join(tmpdir(), "tide-restore-"));
  try {
    const held = await serverHolds(tideHome, deps.probes ?? hostLockProbes());
    if (held !== undefined) throw new RestoreRefused(held);
    if (!existsSync(opts.archive)) throw new RestoreRefused(`${opts.archive} does not exist`);

    await tar(["-xzf", opts.archive, "-C", staging]);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(staging, MANIFEST), "utf8"));
    } catch {
      throw new RestoreRefused("this is not a tide backup archive (no readable manifest.json)");
    }
    const manifest = parseManifest(raw);
    const supported = deps.supportedDbVersion ?? (await supportedDbVersion());
    const archived = typeof manifest.dbUserVersion === "number" ? manifest.dbUserVersion : 0;
    if (supported > 0 && archived > supported) {
      throw new RestoreRefused(`the backup's database schema (${archived}) is newer than this Tide supports (${supported}); update Tide (made by ${manifest.tideVersion}) and restore again`);
    }
    verify(staging, manifest);

    const dbPath = dbPathOf(tideHome);
    const events = await eventCount(dbPath);
    if (events > 0 && !opts.force) {
      const n = Number.isFinite(events) ? `${events} events` : "a database that cannot be read";
      throw new RestoreRefused(
        `TIDE_HOME=${tideHome} already has ${n}. --force moves the current database, settings.json and uploads/ into ${join(tideHome, "pre-restore-<time>")}/ and restores the backup in their place; server.json and clients.json stay as they are.`,
      );
    }

    // move what the backup replaces aside; nothing is deleted
    const aside = join(tideHome, `pre-restore-${stamp((deps.now ?? (() => new Date()))())}`);
    const current = [`${DB_ENTRY}`, `${DB_ENTRY}-wal`, `${DB_ENTRY}-shm`, SETTINGS_ENTRY, UPLOADS_ENTRY].filter((p) => existsSync(join(tideHome, ...p.split("/"))));
    if (current.length > 0) {
      mkdirSync(join(aside, "data"), { recursive: true });
      for (const p of current) renameSync(join(tideHome, ...p.split("/")), join(aside, ...p.split("/")));
      log(`moved the current ${current.join(", ")} to ${aside}`);
    }

    mkdirSync(join(tideHome, "data"), { recursive: true, mode: 0o700 });
    for (const f of manifest.files) {
      const target = join(tideHome, ...f.path.split("/"));
      mkdirSync(join(target, ".."), { recursive: true });
      cpSync(join(staging, ...f.path.split("/")), target);
      if (process.platform !== "win32") chmodSync(target, 0o600);
    }
    log(`restored ${manifest.files.length} file(s) from ${opts.archive} (made by Tide ${manifest.tideVersion} on ${manifest.environmentName}, ${manifest.createdAt})`);
    if (supported === 0) log("note: this build records no database schema version, so the schema check was skipped");
    if (!manifest.keysIncluded && manifest.strippedKeys.length > 0) log(`settings.json came without its keys: ${manifest.strippedKeys.join("; ")}. Re-enter them in Settings.`);
    log("server.json and clients.json were kept: this machine's token and paired devices are unchanged.");
    log("the environment id lives in the database and comes from the backup: do not keep the original machine serving the same data under it.");
    log("worktrees are not in a backup: threads whose worktree folder is missing on this machine need a new worktree (or the branch from the remote).");
    return 0;
  } catch (err) {
    log(err instanceof RestoreRefused ? `tide restore: ${err.message}` : `tide restore failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
