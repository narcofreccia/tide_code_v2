import type { RunConnect, RunListen, RunService } from "@tide/contracts";
import { joinRel, type RepoFs } from "./fsFacade.ts";
import { serviceDir, type ScanCtx } from "./scanCtx.ts";

/** Read in precedence order: the first file defining a key wins. `.env.example` is the only one handed to the model. */
export const ENV_FILES = [".env.local", ".env.development", ".env", ".env.example"];
const PUBLIC_PREFIX = /^(VITE_|EXPO_PUBLIC_|NEXT_PUBLIC_)/;
/** `*_PORT` keys naming infrastructure the repo talks to, not something it listens on */
const INFRA_PORT = /(^|_)(DB|DATABASE|POSTGRES|PG|MYSQL|MARIADB|REDIS|MONGO|MONGODB|SMTP|MAIL|EMAIL|AMQP|RABBIT|RABBITMQ|ELASTIC|S3|MINIO|KAFKA)(_|$)/;
export const LOCAL_URL = /^(https?|wss?|redis):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\$\{?HOST\}?|\d+\.\d+\.\d+\.\d+):(\d{1,5})/;

/** `KEY=value` lines; quotes removed, unquoted values cut at the first `#`. Values are never logged. */
export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let value = (m[2] as string).trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.indexOf(q, 1) > 0) value = value.slice(1, value.indexOf(q, 1));
    else {
      const hash = value.indexOf("#");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    if (!out.has(m[1] as string)) out.set(m[1] as string, value);
  }
  return out;
}

/** `http://192.168.1.50:8000/x` → `http://${host}:${port}/x`; localhost hosts stay literal. */
export function urlTemplate(value: string): { port: number; template: string } | undefined {
  const m = LOCAL_URL.exec(value);
  if (!m) return undefined;
  const host = m[2] as string;
  const lanIp = /^\d+\.\d+\.\d+\.\d+$/.test(host) && host !== "127.0.0.1" && host !== "0.0.0.0";
  const hostOut = lanIp || host.includes("HOST") ? "${host}" : host;
  const head = `${m[1]}://${hostOut}:\${port}`;
  return { port: Number(m[3]), template: head + value.slice(m[0].length) };
}

const listenRef = (repoKey: string, s: RunService, l: RunListen): string => `${repoKey}.${s.id}${s.listens.length > 1 ? `.${l.name}` : ""}`;

function addConnect(s: RunService, c: RunConnect): void {
  if (s.connects.some((x) => x.env === c.env)) return;
  s.connects.push(c);
}

function portListenName(key: string, taken: RunListen[]): string {
  const stem = key.replace(/_?PORT$/, "").split("_").filter((p) => p !== "");
  const base = (stem[stem.length - 1] ?? "port").toLowerCase();
  let name = base;
  for (let i = 2; taken.some((l) => l.name === name); i++) name = `${base}${i}`;
  return name;
}

function applyPortKey(ctx: ScanCtx, targets: RunService[], key: string, port: number): void {
  const all = ctx.services.flatMap((s) => s.listens.map((l) => ({ s, l })));
  if (key === "PORT") {
    const own = targets.flatMap((s) => s.listens).find((l) => l.how === "env" && l.envVar === "PORT");
    if (own) {
      own.port = port;
      return;
    }
  }
  const matches = all.filter(({ l }) => l.port === port);
  if (matches.length > 0) {
    const carried = all.some(({ l }) => l.envVar === key);
    const free = matches.find(({ l }) => l.envVar === undefined && (l.how === "env" || !carried));
    if (free) free.l.envVar = key;
    return;
  }
  if (key === "PORT" || INFRA_PORT.test(key)) return;
  const first = targets[0];
  if (!first) return;
  first.listens.push({ name: portListenName(key, first.listens), port, how: "env", envVar: key });
}

function applyUrlKey(ctx: ScanCtx, targets: RunService[], key: string, value: string): void {
  const t = urlTemplate(value);
  if (t === undefined || targets.length === 0) return;
  const owner = ctx.services.flatMap((s) => s.listens.map((l) => ({ s, l }))).find(({ l }) => l.port === t.port);
  if (owner) {
    // a URL to this repo's own service follows it when the plan moves that service; the owner
    // itself only gets it for public (bundled) keys like VITE_PUBLIC_URL
    const to = listenRef(ctx.repoKey, owner.s, owner.l);
    for (const s of targets) if (s !== owner.s || PUBLIC_PREFIX.test(key)) addConnect(s, { env: key, to, template: t.template });
    return;
  }
  const on = PUBLIC_PREFIX.test(key) ? targets : targets.slice(0, 1);
  for (const s of on) addConnect(s, { env: key, to: `?:${t.port}`, template: t.template });
}

/** `.env*` at the root and in every service dir: `*PORT` keys → listen env vars, localhost URLs → connects. */
export async function detectEnv(ctx: ScanCtx): Promise<void> {
  const dirs = [...new Set(["", ...ctx.services.map(serviceDir)])];
  for (const dir of dirs) {
    const entries = new Map<string, string>();
    for (const file of ENV_FILES) {
      const text = await ctx.read(joinRel(dir, file), { secret: file !== ".env.example", maxBytes: 64 * 1024 });
      if (text === undefined) continue;
      for (const [k, v] of parseDotenv(text)) if (!entries.has(k)) entries.set(k, v);
    }
    if (entries.size === 0) continue;
    const targets = dir === "" ? ctx.services : ctx.services.filter((s) => serviceDir(s) === dir);
    for (const [k, v] of entries) if (/(^|_)PORT$/.test(k) && /^\d{1,5}$/.test(v)) applyPortKey(ctx, targets, k, Number(v));
    for (const [k, v] of entries) applyUrlKey(ctx, targets, k, v);
  }
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "target", ".venv", "venv", "build", "__pycache__", ".tide", ".next", ".expo"]);
const SOURCE_EXT = /\.(m?[jt]sx?|cjs|py|rs)$/;
const OVERRIDE_PATTERNS: RegExp[] = [/load_dotenv\([^)]*override\s*=\s*True/, /dotenv_override/, /dotenv-flow/];

/** Source files (depth 3, ≤ 200 KB) that load `.env` with override semantics: injected env loses. */
export async function detectOverrides(fs: RepoFs, opts: { maxFiles?: number } = {}): Promise<string[]> {
  const found: string[] = [];
  let budget = opts.maxFiles ?? 1500;
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const name of await fs.list(dir)) {
      if (budget <= 0 || found.length >= 5) return;
      if (name.endsWith("/")) {
        const base = name.slice(0, -1);
        if (depth < 3 && !SKIP_DIRS.has(base)) await walk(joinRel(dir, base), depth + 1);
        continue;
      }
      if (!SOURCE_EXT.test(name)) continue;
      budget--;
      const rel = joinRel(dir, name);
      const text = await fs.readText(rel, 200 * 1024);
      if (text === undefined) continue;
      const hit = OVERRIDE_PATTERNS.some((re) => re.test(text)) || (/dotenv/.test(text) && /override:\s*true/.test(text));
      if (hit) found.push(rel);
    }
  };
  await walk("", 0);
  return found.map((rel) => `${rel} loads .env with override — injected env is ignored for keys set there`);
}
