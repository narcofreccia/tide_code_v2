import type { RunListen } from "@tide/contracts";
import { addService, READY_UVICORN, type ScanCtx } from "./scanCtx.ts";

async function venvPrefix(ctx: ScanCtx): Promise<string> {
  for (const v of ["venv", ".venv"]) if (await ctx.fs.exists(`${v}/bin/activate`)) return `source ${v}/bin/activate && `;
  return "";
}

/** FastAPI/uvicorn → `api`; celery → `celery` worker (+ `redis` when mentioned). */
export async function detectPython(ctx: ScanCtx): Promise<void> {
  const parts: string[] = [];
  const pyproject = await ctx.read("pyproject.toml");
  if (pyproject !== undefined) parts.push(pyproject);
  for (const name of await ctx.fs.list("")) {
    if (!/^requirements[\w.-]*\.txt$/i.test(name)) continue;
    const text = await ctx.read(name);
    if (text !== undefined) parts.push(text);
  }
  const deps = parts.join("\n").toLowerCase();
  if (deps === "") return;
  const prefix = await venvPrefix(ctx);
  if (/\b(uvicorn|fastapi)\b/.test(deps)) {
    const module = (await ctx.fs.exists("app/main.py")) ? "app.main" : (await ctx.fs.exists("main.py")) ? "main" : "app.main";
    addService(ctx, {
      id: "api",
      name: "API (uvicorn)",
      command: `${prefix}uvicorn ${module}:app --reload --port 8000`,
      listens: [{ name: "http", port: 8000, how: "flag", flag: "--port" }],
      connects: [],
      env: {},
      readiness: READY_UVICORN,
      kind: "uvicorn",
    });
  }
  if (/\bcelery\b/.test(deps)) {
    const app = (await ctx.fs.exists("app/celery_app.py")) ? "app.celery_app.celery" : "app";
    const redis = /\bredis\b/.test(deps);
    addService(ctx, {
      id: "celery",
      name: "Celery worker",
      command: `${prefix}celery -A ${app} worker --loglevel=info`,
      listens: [],
      connects: [],
      env: {},
      readiness: { kind: "none" },
      kind: "worker",
      ...(redis ? { dependsOn: ["redis"] } : {}),
    });
    if (redis) {
      addService(ctx, {
        id: "redis",
        name: "Redis",
        command: "redis-server",
        listens: [{ name: "redis", port: 6379, how: "flag", flag: "--port" }],
        connects: [],
        env: {},
        readiness: { kind: "port", listen: "redis" },
        kind: "worker",
      });
    }
  }
}

const hasWebRole = (ctx: ScanCtx): boolean => ctx.services.some((s) => s.kind === "uvicorn" || s.kind === "node" || s.kind === "vite" || s.listens.some((l) => l.name === "http"));

/** `web:` / `worker:` lines, only for a role no other detector filled. */
export async function detectProcfile(ctx: ScanCtx): Promise<void> {
  const text = await ctx.read("Procfile");
  if (text === undefined) return;
  for (const line of text.split(/\r?\n/)) {
    const m = /^(web|worker)\s*:\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const role = m[1] as "web" | "worker";
    const command = (m[2] as string).trim();
    if (role === "web" && hasWebRole(ctx)) continue;
    if (role === "worker" && ctx.services.some((s) => s.kind === "worker")) continue;
    const usesPort = /\$\{?PORT\}?/.test(command);
    const listens: RunListen[] = usesPort ? [{ name: "http", port: 5000, how: "env", envVar: "PORT" }] : [];
    addService(ctx, {
      id: role,
      name: `Procfile ${role}`,
      command,
      listens,
      connects: [],
      env: {},
      readiness: usesPort ? { kind: "port", listen: "http" } : { kind: "none" },
      kind: role === "web" ? "other" : "worker",
    });
  }
}

/** Host ports per compose service: `services.<name>.ports: ["5432:5432", "127.0.0.1:8080:80", 9000]`. */
export function composePorts(text: string): { service: string; port: number }[] {
  const out: { service: string; port: number }[] = [];
  let inServices = false;
  let svcIndent = -1;
  let service: string | undefined;
  let inPorts = false;
  let portsIndent = -1;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      inServices = /^services\s*:/.test(line);
      service = undefined;
      inPorts = false;
      svcIndent = -1;
      continue;
    }
    if (!inServices) continue;
    if (svcIndent === -1 || indent <= svcIndent) {
      const m = /^([\w.-]+)\s*:\s*$/.exec(line);
      if (m && (svcIndent === -1 || indent === svcIndent)) {
        svcIndent = indent;
        service = m[1];
        inPorts = false;
        continue;
      }
    }
    if (service === undefined) continue;
    if (/^ports\s*:/.test(line)) {
      inPorts = true;
      portsIndent = indent;
      continue;
    }
    if (inPorts && indent > portsIndent && line.startsWith("-")) {
      const entry = line.slice(1).trim().replace(/^["']|["']$/g, "").replace(/\/(tcp|udp)$/, "");
      const pieces = entry.split(":");
      const host = pieces.length === 1 ? pieces[0] : pieces.length === 2 ? pieces[0] : pieces[1];
      const port = Number(host);
      if (Number.isInteger(port) && port > 0 && port < 65536) out.push({ service, port });
      continue;
    }
    if (indent <= portsIndent) inPorts = false;
  }
  return out;
}

export async function detectCompose(ctx: ScanCtx): Promise<void> {
  for (const name of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
    const text = await ctx.read(name);
    if (text === undefined) continue;
    const ports = composePorts(text);
    const used = new Set<string>();
    const listens: RunListen[] = [];
    for (const p of ports) {
      let n = p.service;
      for (let i = 2; used.has(n); i++) n = `${p.service}-${i}`;
      used.add(n);
      listens.push({ name: n, port: p.port, how: "fixed" });
    }
    addService(ctx, {
      id: "compose",
      name: "docker compose",
      command: "docker compose up",
      listens,
      connects: [],
      env: {},
      readiness: listens.length > 0 ? { kind: "port", listen: (listens[0] as RunListen).name } : { kind: "none" },
      kind: "other",
    });
    return;
  }
}

/** `dev:` / `run:` targets; used only when nothing else was detected. */
export async function detectMakefile(ctx: ScanCtx): Promise<void> {
  const text = await ctx.read("Makefile");
  if (text === undefined) return;
  const target = ["dev", "run"].find((t) => new RegExp(`^${t}\\s*:`, "m").test(text));
  if (target === undefined) return;
  ctx.fallbacks.push({ id: "make", name: `make ${target}`, command: `make ${target}`, listens: [], connects: [], env: {}, readiness: { kind: "none" }, kind: "other" });
}
