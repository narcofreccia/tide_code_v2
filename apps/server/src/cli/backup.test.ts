import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/sqlite.ts";
import type { LockProbes } from "../homeLock.ts";
import { openEventStore } from "../orchestration/store.ts";
import { CliError, parseCli } from "./args.ts";
import { runBackup, stripKeys, type BackupManifest } from "./backup.ts";
import { runRestore } from "./restore.ts";

const temps: string[] = [];
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true });
});
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};

const NOW = new Date(2026, 10, 10, 9, 8, 7);
const SETTINGS = {
  environment: { name: "studio mac" },
  decisions: { enabled: true, apiKey: "sk-decisions" },
  relay: { url: "wss://relay.example", key: "relay-secret" },
  providerInstances: [{ id: "claude-work", kind: "claude", label: "Work", env: { ANTHROPIC_API_KEY: "sk-ant" } }],
  keybindings: { "thread.new": "mod+n" },
};

/** A home with events, settings, uploads and everything a backup must leave out. */
async function seedHome(events = 3): Promise<string> {
  const home = temp("tide-home-");
  mkdirSync(join(home, "data"));
  const store = await openEventStore(join(home, "data", "events.sqlite"));
  store.close();
  const db = await openDatabase(join(home, "data", "events.sqlite"));
  for (let i = 0; i < events; i++) db.prepare("INSERT INTO events (ts, type, aggregate_id, payload) VALUES (?, ?, ?, ?)").run(i, "t", "a", `{"n":${i}}`);
  db.close();
  writeFileSync(join(home, "settings.json"), JSON.stringify(SETTINGS));
  writeFileSync(join(home, "server.json"), JSON.stringify({ environmentId: "env-a", token: "master" }));
  writeFileSync(join(home, "clients.json"), "[]");
  writeFileSync(join(home, "shell.json"), JSON.stringify({ mode: "remote", remote: { url: "http://x", token: "t" } }));
  writeFileSync(join(home, "server.lock"), "{}");
  for (const dir of ["logs", "secrets", "worktrees/p/t", "uploads/a"]) mkdirSync(join(home, dir), { recursive: true });
  writeFileSync(join(home, "logs", "server.log"), "log");
  writeFileSync(join(home, "secrets", "s"), "secret");
  writeFileSync(join(home, "uploads", "a", "pic.png"), "png-bytes");
  return home;
}

async function rows(home: string): Promise<unknown[]> {
  const db = await openDatabase(join(home, "data", "events.sqlite"));
  try {
    return db.prepare("SELECT seq, ts, type, aggregate_id, payload FROM events ORDER BY seq").all();
  } finally {
    db.close();
  }
}

async function backup(home: string, opts: { includeKeys?: boolean } = {}): Promise<{ code: number; file: string; lines: string[] }> {
  const out = temp("tide-out-");
  const lines: string[] = [];
  const code = await runBackup({ includeKeys: opts.includeKeys ?? false }, { tideHome: home, version: "9.9.9", cwd: out, now: () => NOW, log: (l) => lines.push(l) });
  return { code, file: join(out, "tide-backup-studio-mac-20261110-090807.tar.gz"), lines };
}

const listing = (file: string): string[] =>
  execFileSync("tar", ["-tzf", file], { encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim().replace(/^\.\//, ""))
    .filter((l) => l !== "" && !l.endsWith("/"));

const noLock: LockProbes = { alive: () => false, health: async () => undefined };

async function restore(home: string, archive: string, force = false, probes = noLock) {
  const lines: string[] = [];
  const code = await runRestore({ archive, force }, { tideHome: home, now: () => NOW, probes, log: (l) => lines.push(l) });
  return { code, text: lines.join("\n") };
}

describe("tide backup", () => {
  it("archives the db snapshot, stripped settings, uploads and a manifest; nothing else", async () => {
    const home = await seedHome();
    const { code, file, lines } = await backup(home);
    expect(code).toBe(0);
    expect(listing(file).sort()).toEqual(["data/events.sqlite", "manifest.json", "settings.json", "uploads/a/pic.png"]);
    expect(lines.join("\n")).toContain("without its keys");

    const x = temp("tide-x-");
    execFileSync("tar", ["-xzf", file, "-C", x]);
    const manifest = JSON.parse(readFileSync(join(x, "manifest.json"), "utf8")) as BackupManifest;
    expect(manifest).toMatchObject({ format: "tide-backup", tideVersion: "9.9.9", environmentName: "studio mac", keysIncluded: false, createdAt: NOW.toISOString() });
    expect(typeof manifest.dbUserVersion).toBe("number");
    expect(manifest.files.map((f) => f.path)).toEqual(["data/events.sqlite", "settings.json", "uploads/a/pic.png"]);
    expect(manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && f.size > 0)).toBe(true);
    const settings = readFileSync(join(x, "settings.json"), "utf8");
    for (const secret of ["sk-decisions", "relay-secret", "sk-ant"]) expect(settings).not.toContain(secret);
    expect(JSON.parse(settings)).toMatchObject({ relay: { url: "wss://relay.example" }, keybindings: SETTINGS.keybindings });
  });

  it("keeps the keys with --include-keys and warns", async () => {
    const home = await seedHome();
    const { code, file, lines } = await backup(home, { includeKeys: true });
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/warning: .*API keys/);
    const x = temp("tide-x-");
    execFileSync("tar", ["-xzf", file, "-C", x]);
    expect(JSON.parse(readFileSync(join(x, "settings.json"), "utf8"))).toEqual(SETTINGS);
  });

  it("refuses a home without a database", async () => {
    const { code, lines } = await backup(temp("tide-empty-"));
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("no database");
  });

  it("strips every key field and names what it stripped", () => {
    const { settings, stripped } = stripKeys(SETTINGS);
    expect(stripped).toEqual(["decisions.apiKey", "relay.key", "providerInstances[claude-work].env (ANTHROPIC_API_KEY)"]);
    expect(SETTINGS.decisions.apiKey).toBe("sk-decisions"); // input untouched
    expect(JSON.stringify(settings)).not.toMatch(/sk-|relay-secret/);
  });
});

describe("tide restore", () => {
  it("round-trips into an empty home and keeps its identity files", async () => {
    const source = await seedHome(5);
    const { file } = await backup(source);
    const target = temp("tide-target-");
    writeFileSync(join(target, "server.json"), JSON.stringify({ environmentId: "env-b", token: "other" }));
    writeFileSync(join(target, "clients.json"), "[1]");
    const r = await restore(target, file);
    expect(r.code).toBe(0);
    expect(await rows(target)).toEqual(await rows(source));
    expect(JSON.parse(readFileSync(join(target, "settings.json"), "utf8"))).toEqual(stripKeys(SETTINGS).settings);
    expect(readFileSync(join(target, "uploads", "a", "pic.png"), "utf8")).toBe("png-bytes");
    expect(JSON.parse(readFileSync(join(target, "server.json"), "utf8"))).toEqual({ environmentId: "env-b", token: "other" });
    expect(readFileSync(join(target, "clients.json"), "utf8")).toBe("[1]");
    expect(r.text).toContain("Re-enter them");
  });

  it("refuses a home with events unless --force, then moves the old files aside", async () => {
    const { file } = await backup(await seedHome(2));
    const target = await seedHome(7);
    const refused = await restore(target, file);
    expect(refused.code).toBe(1);
    expect(refused.text).toMatch(/already has 7 events\. --force moves/);
    expect(await rows(target)).toHaveLength(7);

    const forced = await restore(target, file, true);
    expect(forced.code).toBe(0);
    expect(await rows(target)).toHaveLength(2);
    const aside = join(target, "pre-restore-20261110-090807");
    expect(readdirSync(aside).sort()).toEqual(["data", "settings.json", "uploads"]);
    expect(await rows(aside)).toHaveLength(7);
    expect(existsSync(join(target, "server.json"))).toBe(true);
  });

  it("refuses while a server holds the lock", async () => {
    const { file } = await backup(await seedHome());
    const target = temp("tide-target-");
    writeFileSync(join(target, "server.json"), JSON.stringify({ environmentId: "env-b", token: "t" }));
    writeFileSync(join(target, "server.lock"), JSON.stringify({ pid: 999_999, port: 3999, startedAt: 1, version: "x" }));
    const r = await restore(target, file, true, { alive: () => true, health: async () => "env-b" });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/is running on TIDE_HOME=.*stop it/);
    expect(existsSync(join(target, "data"))).toBe(false);
  });

  it("refuses a damaged archive and a newer schema", async () => {
    const { file } = await backup(await seedHome());
    const x = temp("tide-x-");
    execFileSync("tar", ["-xzf", file, "-C", x]);
    writeFileSync(join(x, "settings.json"), "{}");
    const bad = join(temp("tide-bad-"), "bad.tar.gz");
    execFileSync("tar", ["-czf", bad, "-C", x, "manifest.json", "data", "settings.json", "uploads"]);
    const r = await restore(temp("tide-target-"), bad);
    expect(r.code).toBe(1);
    expect(r.text).toContain("checksum mismatch for settings.json");

    const lines: string[] = [];
    const newer = await runRestore({ archive: file, force: false }, { tideHome: temp("tide-target-"), probes: noLock, supportedDbVersion: -1, log: (l) => lines.push(l) });
    expect(newer).toBe(0); // a negative/zero supported version means "unknown": the check is skipped
    const manifest = JSON.parse(readFileSync(join(x, "manifest.json"), "utf8")) as BackupManifest;
    writeFileSync(join(x, "manifest.json"), JSON.stringify({ ...manifest, dbUserVersion: 99 }));
    const future = join(temp("tide-future-"), "future.tar.gz");
    execFileSync("tar", ["-czf", future, "-C", x, "manifest.json", "data", "uploads"]);
    const lines2: string[] = [];
    const code = await runRestore({ archive: future, force: false }, { tideHome: temp("tide-target-"), probes: noLock, supportedDbVersion: 3, log: (l) => lines2.push(l) });
    expect(code).toBe(1);
    expect(lines2.join("\n")).toMatch(/schema \(99\) is newer than this Tide supports \(3\)/);
  });
});

describe("parseCli backup/restore", () => {
  it("parses the flags", () => {
    expect(parseCli(["backup"])).toEqual({ cmd: "backup", includeKeys: false });
    expect(parseCli(["backup", "--out", "/x.tar.gz", "--include-keys"])).toEqual({ cmd: "backup", out: "/x.tar.gz", includeKeys: true });
    expect(() => parseCli(["backup", "--out"])).toThrow(CliError);
    expect(parseCli(["restore", "a.tar.gz", "--force"])).toEqual({ cmd: "restore", archive: "a.tar.gz", force: true });
    expect(() => parseCli(["restore"])).toThrow(/needs the archive/);
    expect(() => parseCli(["restore", "a", "b"])).toThrow(/one archive/);
  });
});
