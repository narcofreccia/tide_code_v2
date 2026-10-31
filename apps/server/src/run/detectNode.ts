import type { RunListen, RunService } from "@tide/contracts";
import { joinRel } from "./fsFacade.ts";
import {
  addService,
  detectPm,
  existingPortFlag,
  READY_EXPO,
  READY_TAURI,
  READY_VITE,
  runScript,
  serviceDir,
  viteListen,
  type PackageManager,
  type ScanCtx,
} from "./scanCtx.ts";

interface Pkg {
  scripts: Record<string, string>;
  deps: Record<string, string>;
}

const FIXED_SUBDIRS = ["gui", "web", "frontend", "client", "app"];
const VITE_CONFIGS = ["vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs"];
const VITE_SCRIPT_ORDER = ["dev", "start:dev", "start", "vite"];
const isViteScript = (cmd: string): boolean => /(^|[\s&;|])vite(\s+dev|\s+serve)?(\s|$)/.test(cmd) && !/\bvite\s+(build|preview)\b/.test(cmd);

/** Root plus one level of the usual frontend subdirs and `apps/*`, those holding a package.json. */
export async function packageDirs(ctx: ScanCtx): Promise<string[]> {
  const out = [""];
  for (const d of FIXED_SUBDIRS) out.push(d);
  for (const name of await ctx.fs.list("apps")) if (name.endsWith("/")) out.push(`apps/${name.slice(0, -1)}`);
  const found: string[] = [];
  for (const d of out) if (await ctx.fs.exists(joinRel(d, "package.json"))) found.push(d);
  return found;
}

async function readPkg(ctx: ScanCtx, dir: string): Promise<Pkg | undefined> {
  const text = await ctx.read(joinRel(dir, "package.json"));
  if (text === undefined) return undefined;
  try {
    const raw = JSON.parse(text) as { scripts?: Record<string, unknown>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const scripts: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.scripts ?? {})) if (typeof v === "string") scripts[k] = v;
    return { scripts, deps: { ...raw.dependencies, ...raw.devDependencies } };
  } catch {
    ctx.warnings.push(`${joinRel(dir, "package.json")} is not valid JSON`);
    return undefined;
  }
}

async function readFirst(ctx: ScanCtx, dir: string, names: string[]): Promise<string | undefined> {
  for (const n of names) {
    const text = await ctx.read(joinRel(dir, n));
    if (text !== undefined) return text;
  }
  return undefined;
}

/** `server: { port: N, strictPort: bool }` by regex; the first `port:` after `server` wins (hmr ports come later). */
export function viteServerPort(config: string | undefined): { port?: number; strict: boolean } {
  if (config === undefined) return { strict: false };
  const at = config.search(/\bserver\s*:\s*\{/);
  const body = at === -1 ? "" : config.slice(at);
  const port = /\bport\s*:\s*(\d{2,5})/.exec(body);
  return { ...(port ? { port: Number(port[1]) } : {}), strict: /\bstrictPort\s*:\s*true/.test(body) };
}

const cwdOf = (dir: string): { cwd?: string } => (dir === "" ? {} : { cwd: dir });

async function detectExpo(ctx: ScanCtx, dir: string, pkg: Pkg, pm: PackageManager): Promise<boolean> {
  const appJson = await ctx.read(joinRel(dir, "app.json"));
  const appConfig = await readFirst(ctx, dir, ["app.config.ts", "app.config.js"]);
  const isExpo = (appJson !== undefined && /"expo"\s*:/.test(appJson)) || (appConfig !== undefined && /expo/i.test(appConfig));
  if (!isExpo) return false;
  const command = pkg.scripts["start:dev"] !== undefined ? runScript(pm, "start:dev") : "npx expo start";
  addService(ctx, {
    id: "metro",
    name: "Expo (Metro)",
    ...cwdOf(dir),
    command,
    listens: [{ name: "metro", port: 8081, how: "flag", flag: "--port" }],
    connects: [],
    env: {},
    readiness: READY_EXPO,
    kind: "expo",
    default: false,
  });
  return true;
}

/** Script that runs `tauri dev` in `pkg`, if any: `tauri:dev`, `dev:tauri`, or a value containing "tauri dev". */
function tauriDevScript(pkg: Pkg | undefined): string | undefined {
  if (pkg === undefined) return undefined;
  for (const k of ["tauri:dev", "dev:tauri"]) if (pkg.scripts[k] !== undefined) return k;
  return Object.keys(pkg.scripts).find((k) => /\btauri\s+dev\b/.test(pkg.scripts[k] as string));
}

/** Last `npm run x` / `pnpm x` / `yarn x` / `bun run x` in a beforeDevCommand. */
export function wrappedScript(before: string): string | undefined {
  let last: string | undefined;
  for (const m of before.matchAll(/(?:npm run|pnpm(?: run)?|yarn(?: run)?|bun run)\s+([a-zA-Z][\w:-]*)/g)) last = m[1];
  return last;
}

async function detectTauri(ctx: ScanCtx, dir: string, pkg: Pkg, pm: PackageManager, rootPkg: Pkg | undefined, viteConfig: string | undefined): Promise<boolean> {
  const rel = joinRel(dir, "src-tauri/tauri.conf.json");
  const text = await ctx.read(rel);
  if (text === undefined) return false;
  let build: { devUrl?: unknown; devPath?: unknown; beforeDevCommand?: unknown } = {};
  try {
    build = (JSON.parse(text) as { build?: typeof build }).build ?? {};
  } catch {
    ctx.warnings.push(`${rel} is not valid JSON`);
    return false;
  }
  const url = typeof build.devUrl === "string" ? build.devUrl : typeof build.devPath === "string" ? build.devPath : undefined;
  const portMatch = url === undefined ? null : /^https?:\/\/[^/:]+:(\d{1,5})/.exec(url);
  const port = portMatch ? Number(portMatch[1]) : undefined;
  const listens: RunListen[] = [];
  if (port !== undefined) {
    listens.push({ name: "http", port, how: "fixed" });
    if (viteConfig !== undefined && /\bhmr\b/.test(viteConfig)) listens.push({ name: "hmr", port: port + 1, how: "fixed" });
  }

  let command: string;
  let cwd = dir;
  const own = tauriDevScript(pkg);
  const atRoot = dir === "" ? undefined : tauriDevScript(rootPkg);
  if (own !== undefined) command = runScript(pm, own);
  else if (atRoot !== undefined) {
    command = runScript(await detectPm(ctx, ""), atRoot);
    cwd = "";
  } else if (pkg.scripts["tauri"] !== undefined) command = runScript(pm, "tauri", "dev");
  else command = "npx tauri dev";

  // the dev server Tauri starts itself (beforeDevCommand) is not a service of its own
  const before = typeof build.beforeDevCommand === "string" ? build.beforeDevCommand : (build.beforeDevCommand as { script?: string } | undefined)?.script;
  const wrapped = before === undefined ? undefined : wrappedScript(before);
  const connects: RunService["connects"] = [];
  ctx.services = ctx.services.filter((s) => {
    if (s.kind !== "vite" || serviceDir(s) !== dir) return true;
    const script = /(?:npm run|pnpm|yarn|bun run)\s+([\w:-]+)/.exec(s.command)?.[1];
    const wraps = (wrapped !== undefined && script === wrapped) || (port !== undefined && s.listens.some((l) => l.port === port));
    if (wraps) connects.push(...s.connects);
    return !wraps;
  });

  addService(ctx, {
    id: "app",
    name: "Tauri app",
    ...cwdOf(cwd),
    command,
    listens,
    connects,
    env: {},
    readiness: READY_TAURI,
    kind: "tauri",
  });
  return true;
}

async function detectDir(ctx: ScanCtx, dir: string, rootPkg: Pkg | undefined): Promise<void> {
  const pkg = dir === "" ? rootPkg : await readPkg(ctx, dir);
  if (pkg === undefined) return;
  const pm = await detectPm(ctx, dir);
  if (await detectExpo(ctx, dir, pkg, pm)) return;

  const viteConfig = await readFirst(ctx, dir, VITE_CONFIGS);
  const viteScript = VITE_SCRIPT_ORDER.find((k) => pkg.scripts[k] !== undefined && isViteScript(pkg.scripts[k] as string));
  let found = false;
  if (viteScript !== undefined) {
    const cfg = viteServerPort(viteConfig);
    const port = existingPortFlag(pkg.scripts[viteScript] as string)?.port ?? cfg.port ?? 5173;
    addService(ctx, {
      id: "web",
      name: "Vite dev server",
      ...cwdOf(dir),
      command: runScript(pm, viteScript),
      listens: [viteListen(port)],
      connects: [],
      env: {},
      readiness: READY_VITE,
      kind: "vite",
    });
    found = true;
  }
  const start = pkg.scripts["start"];
  if (start !== undefined && /^node\s/.test(start.trim())) {
    addService(ctx, {
      id: "server",
      name: "Node server",
      ...cwdOf(dir),
      command: runScript(pm, "start"),
      listens: [{ name: "http", port: 3000, how: "env", envVar: "PORT" }],
      connects: [],
      env: {},
      readiness: { kind: "port", listen: "http" },
      kind: "node",
      ...(found ? { default: false } : {}),
    });
    found = true;
  }
  if (await detectTauri(ctx, dir, pkg, pm, rootPkg, viteConfig)) found = true;
  if (!found && pkg.scripts["dev"] !== undefined && tauriDevScript(pkg) !== "dev") {
    ctx.fallbacks.push({
      id: "dev",
      name: dir === "" ? "dev script" : `${dir} dev script`,
      ...cwdOf(dir),
      command: runScript(pm, "dev"),
      listens: [],
      connects: [],
      env: {},
      readiness: { kind: "none" },
      kind: "node",
    });
  }
}

/** package.json scripts, Vite config, Tauri config and Expo app config across the package dirs. */
export async function detectNode(ctx: ScanCtx): Promise<void> {
  const dirs = await packageDirs(ctx);
  const rootPkg = dirs.includes("") ? await readPkg(ctx, "") : undefined;
  for (const dir of dirs) await detectDir(ctx, dir, rootPkg);
}
