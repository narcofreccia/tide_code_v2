import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Exec } from "./service.ts";
import { compareVersions, platformTriple, runUpdate, UPDATE_BASE, type UpdateDeps } from "./update.ts";

const TRIPLE = "x86_64-unknown-linux-gnu";
const SERVER_BYTES = Buffer.from("server-tarball-bytes");
const WEB_BYTES = Buffer.from("web-tarball-bytes");
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

let root: string;
let binDir: string;
let execPath: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tide-update-"));
  binDir = join(root, "bin");
  home = join(root, "home");
  mkdirSync(join(binDir, "web"), { recursive: true });
  mkdirSync(home, { recursive: true });
  execPath = join(binDir, "tide-server");
  writeFileSync(execPath, "OLD BINARY");
  writeFileSync(join(binDir, "web", "index.html"), "old web");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "0.9.0",
    notes: "v0.9.0",
    server: { [TRIPLE]: { url: `${UPDATE_BASE}/server/${TRIPLE}/tide-server.tar.gz`, sha256: sha(SERVER_BYTES), version: "0.9.0" } },
    web: { url: `${UPDATE_BASE}/web/web.tar.gz`, sha256: sha(WEB_BYTES), version: "0.9.0" },
    ...over,
  };
}

function setup(m: Record<string, unknown>, over: Partial<UpdateDeps> & { probeVersion?: string } = {}) {
  const lines: string[] = [];
  const calls: string[][] = [];
  const fetched: string[] = [];
  const fakeFetch = async (url: string): Promise<Response> => {
    fetched.push(url);
    if (url.endsWith("/latest.json")) return Response.json(m);
    if (url.endsWith("tide-server.tar.gz")) return new Response(SERVER_BYTES);
    if (url.endsWith("web.tar.gz")) return new Response(WEB_BYTES);
    return new Response("nope", { status: 404 });
  };
  // fake tar: "extracts" by writing what the real tarballs contain
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    if (file === "tar") {
      const [, archive = "", , into = ""] = args;
      if (basename(archive) === "tide-server.tar.gz") writeFileSync(join(into, "tide-server"), "NEW BINARY");
      else {
        mkdirSync(join(into, "web"), { recursive: true });
        writeFileSync(join(into, "web", "index.html"), "new web");
      }
      return { code: 0, out: "" };
    }
    if (file === execPath) return { code: 0, out: over.probeVersion ?? "0.9.0" };
    return { code: 0, out: "" };
  };
  const deps: UpdateDeps = {
    fetch: fakeFetch,
    version: "0.8.2",
    tideHome: join(root, "tide-home"),
    platformTriple: TRIPLE,
    execPath,
    exec,
    isCompiled: true,
    log: (line) => lines.push(line),
    platform: "linux",
    home,
    uid: 501,
    ...over,
  };
  return { deps, lines, calls, fetched, text: () => lines.join("\n") };
}

describe("compareVersions / platformTriple", () => {
  it("orders dotted versions and prereleases", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("v1.2", "1.2.0")).toBe(0);
  });
  it("maps node platforms to rust triples", () => {
    expect(platformTriple("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(platformTriple("linux", "x64")).toBe(TRIPLE);
    expect(platformTriple("freebsd", "x64")).toBeUndefined();
  });
});

describe("runUpdate", () => {
  it("says so when up to date", async () => {
    const t = setup(manifest(), { version: "0.9.0" });
    expect(await runUpdate({ check: false, yes: true }, t.deps)).toBe(0);
    expect(t.text()).toMatch(/0\.9\.0 is up to date/);
    expect(t.fetched).toEqual([`${UPDATE_BASE}/latest.json`]);
  });

  it("--check prints the versions and notes, then stops", async () => {
    const t = setup(manifest());
    expect(await runUpdate({ check: true, yes: false }, t.deps)).toBe(0);
    expect(t.lines.slice(0, 2)).toEqual(["Tide 0.8.2 → 0.9.0", "v0.9.0"]);
    expect(t.fetched).toHaveLength(1);
  });

  it("reports a manifest without a server key as no headless artifact yet", async () => {
    const m = manifest();
    delete m["server"];
    const t = setup(m);
    expect(await runUpdate({ check: false, yes: true }, t.deps)).toBe(0);
    expect(t.text()).toMatch(/no headless artifact for this platform yet \(x86_64-unknown-linux-gnu at 0\.9\.0\)/);
    expect(readFileSync(execPath, "utf8")).toBe("OLD BINARY");
  });

  it("treats a server entry from an older release as missing", async () => {
    const m = manifest();
    (m["server"] as Record<string, Record<string, string>>)[TRIPLE]!["version"] = "0.8.0";
    const t = setup(m);
    expect(await runUpdate({ check: false, yes: true }, t.deps)).toBe(0);
    expect(t.text()).toMatch(/no headless artifact/);
  });

  it("points a dev checkout at git pull", async () => {
    const t = setup(manifest(), { isCompiled: false });
    expect(await runUpdate({ check: false, yes: true }, t.deps)).toBe(0);
    expect(t.text()).toMatch(/dev checkout: git pull && pnpm install/);
  });

  it("leaves a desktop-bundled sidecar to the app's updater", async () => {
    const t = setup(manifest(), { execPath: "/Applications/Tide.app/Contents/MacOS/tide-server", platform: "darwin" });
    expect(await runUpdate({ check: false, yes: true }, t.deps)).toBe(0);
    expect(t.text()).toMatch(/update from the app \(Settings › About\)/);
    writeFileSync(join(binDir, "tide-desktop"), "");
    const linux = setup(manifest());
    expect(await runUpdate({ check: false, yes: true }, linux.deps)).toBe(0);
    expect(linux.text()).toMatch(/update from the app/);
  });

  it("downloads, verifies, swaps binary + web and asks to restart", async () => {
    const t = setup(manifest());
    expect(await runUpdate({ check: false, yes: true }, t.deps)).toBe(0);
    expect(readFileSync(execPath, "utf8")).toBe("NEW BINARY");
    expect(readFileSync(`${execPath}.old`, "utf8")).toBe("OLD BINARY");
    expect(readFileSync(join(binDir, "web", "index.html"), "utf8")).toBe("new web");
    expect(existsSync(join(binDir, "web.old"))).toBe(false);
    expect(existsSync(join(root, "tide-home", "updates", "0.9.0"))).toBe(false);
    expect(t.calls).toContainEqual([execPath, "--version"]);
    expect(t.text()).toMatch(/restart tide-server to use 0\.9\.0/);
  });

  it("asks before changing anything and stops on no", async () => {
    const asked: string[] = [];
    const t = setup(manifest(), { confirm: async (q) => (asked.push(q), false) });
    expect(await runUpdate({ check: false, yes: false }, t.deps)).toBe(1);
    expect(asked).toEqual(["Update to 0.9.0? [y/N] "]);
    expect(t.text()).toMatch(/plan:/);
    expect(readFileSync(execPath, "utf8")).toBe("OLD BINARY");
  });

  it("refuses a bad sha256 and leaves the install and the staged download alone", async () => {
    const m = manifest({ web: { url: `${UPDATE_BASE}/web/web.tar.gz`, sha256: "0".repeat(64) } });
    const t = setup(m);
    expect(await runUpdate({ check: false, yes: true }, t.deps)).toBe(1);
    expect(t.text()).toMatch(/sha256 mismatch for web\.tar\.gz/);
    expect(readFileSync(execPath, "utf8")).toBe("OLD BINARY");
    expect(existsSync(`${execPath}.old`)).toBe(false);
    expect(existsSync(join(root, "tide-home", "updates", "0.9.0", "web.tar.gz"))).toBe(true);
  });

  it("rolls back to .old when the new binary does not report the new version", async () => {
    const t = setup(manifest(), { probeVersion: "garbage" });
    expect(await runUpdate({ check: false, yes: true }, t.deps)).toBe(1);
    expect(readFileSync(execPath, "utf8")).toBe("OLD BINARY");
    expect(existsSync(`${execPath}.old`)).toBe(false);
    expect(readFileSync(join(binDir, "web", "index.html"), "utf8")).toBe("old web");
    expect(t.text()).toMatch(/restored the previous binary/);
  });

  it("restarts an installed service with the platform's manager", async () => {
    mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(join(home, ".config", "systemd", "user", "tide-server.service"), "");
    const linux = setup(manifest());
    expect(await runUpdate({ check: false, yes: true }, linux.deps)).toBe(0);
    expect(linux.calls).toContainEqual(["systemctl", "--user", "restart", "tide-server.service"]);

    writeFileSync(execPath, "OLD BINARY");
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(home, "Library", "LaunchAgents", "com.tide.server.plist"), "");
    const mac = setup(manifest({ server: { "aarch64-apple-darwin": { url: `${UPDATE_BASE}/server/aarch64-apple-darwin/tide-server.tar.gz`, sha256: sha(SERVER_BYTES) } } }), {
      platform: "darwin",
      platformTriple: "aarch64-apple-darwin",
    });
    expect(await runUpdate({ check: false, yes: true }, mac.deps)).toBe(0);
    expect(mac.calls).toContainEqual(["launchctl", "kickstart", "-k", "gui/501/com.tide.server"]);
    expect(mac.text()).toMatch(/the service restarted on 0\.9\.0/);
  });
});
