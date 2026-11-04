import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { LAUNCHD_LABEL, SYSTEMD_UNIT, serviceFile, type Exec } from "./service.ts";

/** Public base of the release bucket (docs/RELEASING.md); `latest.json` lives right under it. */
export const UPDATE_BASE = "https://pub-7b3e5bbd605d43adbeb4601a962d84bd.r2.dev/tidecode";

export type Fetch = (url: string) => Promise<Response>;

export interface UpdateDeps {
  fetch: Fetch;
  /** the running VERSION */
  version: string;
  tideHome: string;
  /** Rust target triple of this machine, undefined when no headless build exists for it */
  platformTriple: string | undefined;
  execPath: string;
  exec: Exec;
  /** a bun-compiled binary, not `node … src/bin.ts` from a checkout */
  isCompiled: boolean;
  log: (line: string) => void;
  /** asked unless `--yes`; resolves true to go ahead */
  confirm?: (question: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number;
  baseUrl?: string;
}

interface Artifact {
  url: string;
  sha256: string;
  version?: string;
}

interface Manifest {
  version: string;
  notes?: string;
  server?: Record<string, Artifact>;
  web?: Artifact;
}

/** node's platform/arch → the Rust triple the release names its server tarball after. */
export function platformTriple(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  const table: Record<string, string> = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "win32-x64": "x86_64-pc-windows-msvc",
  };
  return table[`${platform}-${arch}`];
}

/** -1 / 0 / 1. Numeric dotted core; a prerelease (`1.2.0-rc.1`) sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { core: number[]; pre: string } => {
    const [core = "", pre = ""] = v.trim().replace(/^v/, "").split(/-(.*)/s);
    return { core: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === "") return 1;
  if (y.pre === "") return -1;
  return x.pre > y.pre ? 1 : -1;
}

/** The sidecar inside a desktop install: the app's own updater owns it. */
export function insideTauriBundle(execPath: string): boolean {
  if (/\.app\/Contents\/MacOS\//.test(execPath)) return true;
  const dir = dirname(execPath);
  return ["Tide.exe", "tide-desktop", "tide-desktop.exe"].some((name) => existsSync(join(dir, name)));
}

const isArtifact = (v: unknown): v is Artifact =>
  typeof v === "object" && v !== null && typeof (v as Artifact).url === "string" && typeof (v as Artifact).sha256 === "string";

function parseManifest(raw: unknown): Manifest {
  if (typeof raw !== "object" || raw === null || typeof (raw as Manifest).version !== "string") throw new Error("latest.json has no version");
  const m = raw as Manifest;
  return { version: m.version, ...(typeof m.notes === "string" ? { notes: m.notes } : {}), ...(typeof m.server === "object" && m.server !== null ? { server: m.server } : {}), ...(isArtifact(m.web) ? { web: m.web } : {}) };
}

async function download(deps: UpdateDeps, artifact: Artifact, file: string): Promise<void> {
  deps.log(`downloading ${artifact.url}`);
  const res = await deps.fetch(artifact.url);
  if (!res.ok) throw new Error(`${artifact.url} answered ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== artifact.sha256.trim().toLowerCase()) throw new Error(`sha256 mismatch for ${basename(file)}: expected ${artifact.sha256}, got ${sha}`);
}

async function extract(deps: UpdateDeps, file: string, into: string): Promise<void> {
  mkdirSync(into, { recursive: true });
  const r = await deps.exec("tar", ["-xzf", file, "-C", into]);
  if (r.code !== 0) throw new Error(`tar -xzf ${basename(file)} failed${r.out ? `: ${r.out}` : ""}`);
}

/** `tide update [--check] [--yes]`: returns the exit code; every line goes through `deps.log`. */
export async function runUpdate(opts: { check: boolean; yes: boolean }, deps: UpdateDeps): Promise<number> {
  const { log } = deps;
  const platform = deps.platform ?? process.platform;
  const base = (deps.baseUrl ?? UPDATE_BASE).replace(/\/+$/, "");

  let manifest: Manifest;
  try {
    const res = await deps.fetch(`${base}/latest.json`);
    if (!res.ok) throw new Error(`${base}/latest.json answered ${res.status}`);
    manifest = parseManifest(await res.json());
  } catch (err) {
    log(`tide update: could not read the release manifest: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const next = manifest.version;
  if (compareVersions(next, deps.version) <= 0) {
    log(`Tide ${deps.version} is up to date (latest release: ${next}).`);
    return 0;
  }
  log(`Tide ${deps.version} → ${next}`);
  if (manifest.notes) log(manifest.notes);
  if (opts.check) return 0;

  if (!deps.isCompiled) {
    log("dev checkout: git pull && pnpm install");
    return 0;
  }
  if (insideTauriBundle(deps.execPath)) {
    log("This tide-server belongs to the desktop app: update from the app (Settings › About).");
    return 0;
  }
  const triple = deps.platformTriple;
  const server = triple === undefined ? undefined : manifest.server?.[triple];
  if (triple === undefined || !isArtifact(server) || (server.version !== undefined && server.version !== next)) {
    log(`no headless artifact for this platform yet (${triple ?? `${platform}-${process.arch}`} at ${next}); it is published with each release.`);
    return 0;
  }
  const web = manifest.web !== undefined && (manifest.web.version === undefined || manifest.web.version === next) ? manifest.web : undefined;

  const binDir = dirname(deps.execPath);
  const webDir = join(binDir, "web");
  const home = deps.home ?? process.env["HOME"] ?? "";
  const svcPlatform = platform === "darwin" || platform === "linux" ? platform : undefined;
  const serviceInstalled = svcPlatform !== undefined && home !== "" && existsSync(serviceFile(svcPlatform, home));
  const restart: [string, string[]] | undefined = !serviceInstalled
    ? undefined
    : svcPlatform === "darwin"
      ? ["launchctl", ["kickstart", "-k", `gui/${deps.uid ?? process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`]]
      : ["systemctl", ["--user", "restart", SYSTEMD_UNIT]];

  for (const line of ["", "plan:", `  download ${server.url}`, web ? `  download ${web.url}` : "  (no web bundle in this release: the web client stays as it is)"]) log(line);
  log(`  replace ${deps.execPath} (the current one is kept as ${basename(deps.execPath)}.old)`);
  if (web) log(`  replace ${webDir}`);
  log(restart ? `  restart the service: ${restart[0]} ${restart[1].join(" ")}` : "  no service installed: restart tide-server yourself afterwards");
  if (!opts.yes) {
    const ok = deps.confirm ? await deps.confirm(`Update to ${next}? [y/N] `) : false;
    if (!ok) {
      log("cancelled (pass --yes to skip the question)");
      return 1;
    }
  }

  const stage = join(deps.tideHome, "updates", next);
  const exeName = platform === "win32" ? "tide-server.exe" : "tide-server";
  const old = `${deps.execPath}.old`;
  const oldWeb = `${webDir}.old`;
  let swappedBin = false;
  let swappedWeb = false;
  try {
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    await download(deps, server, join(stage, "tide-server.tar.gz"));
    if (web) await download(deps, web, join(stage, "web.tar.gz"));
    await extract(deps, join(stage, "tide-server.tar.gz"), join(stage, "server"));
    const newBin = join(stage, "server", exeName);
    if (!existsSync(newBin)) throw new Error(`the server tarball has no ${exeName}`);
    let newWeb: string | undefined;
    if (web) {
      await extract(deps, join(stage, "web.tar.gz"), join(stage, "webroot"));
      newWeb = join(stage, "webroot", "web");
      if (!existsSync(join(newWeb, "index.html"))) throw new Error("the web tarball has no web/index.html");
    }

    // stage beside the target first so the swap is two renames on one filesystem
    const incoming = `${deps.execPath}.new`;
    copyFileSync(newBin, incoming);
    chmodSync(incoming, 0o755);
    rmSync(old, { force: true });
    renameSync(deps.execPath, old);
    swappedBin = true;
    renameSync(incoming, deps.execPath);
    if (newWeb !== undefined) {
      const incomingWeb = `${webDir}.new`;
      rmSync(incomingWeb, { recursive: true, force: true });
      cpSync(newWeb, incomingWeb, { recursive: true });
      rmSync(oldWeb, { recursive: true, force: true });
      if (existsSync(webDir)) renameSync(webDir, oldWeb);
      swappedWeb = true;
      renameSync(incomingWeb, webDir);
    }

    // the new binary must run and report the version we meant to install
    const probe = await deps.exec(deps.execPath, ["--version"]);
    if (probe.code !== 0 || probe.out.trim() !== next) throw new Error(`the new binary reports ${JSON.stringify(probe.out.trim())} (exit ${probe.code}), expected ${next}`);
  } catch (err) {
    rmSync(`${deps.execPath}.new`, { force: true });
    rmSync(`${webDir}.new`, { recursive: true, force: true });
    if (swappedBin && existsSync(old)) {
      rmSync(deps.execPath, { force: true });
      renameSync(old, deps.execPath);
    }
    if (swappedWeb) {
      rmSync(webDir, { recursive: true, force: true });
      if (existsSync(oldWeb)) renameSync(oldWeb, webDir);
    }
    log(`update failed: ${err instanceof Error ? err.message : String(err)}`);
    log(`${swappedBin ? "restored the previous binary; " : ""}nothing changed. The downloads stay in ${stage} for inspection.`);
    return 1;
  }

  rmSync(stage, { recursive: true, force: true });
  rmSync(oldWeb, { recursive: true, force: true });
  log(`installed Tide ${next} at ${deps.execPath}`);
  if (!restart) {
    log(`restart tide-server to use ${next}`);
    return 0;
  }
  const r = await deps.exec(restart[0], restart[1]);
  log(`$ ${restart[0]} ${restart[1].join(" ")}${r.out ? `\n${r.out}` : ""}`);
  if (r.code !== 0) {
    log(`the service did not restart; restart tide-server to use ${next}`);
    return 1;
  }
  log(`the service restarted on ${next}`);
  return 0;
}
