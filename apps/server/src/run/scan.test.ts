import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { RunProfile } from "@tide/contracts";
import { parseDotenv, urlTemplate } from "./detectEnv.ts";
import { viteServerPort, wrappedScript } from "./detectNode.ts";
import { composePorts } from "./detectOther.ts";
import { memRepoFs } from "./fsFacade.ts";
import { defaultRepoKey, existingPortFlag, scanRepo } from "./scan.ts";
import { tideBackend, tideFrontend, tidePos2, tidePosApp, tideReel } from "./testing/fixtures.ts";

const scan = async (files: Record<string, string>, repoKey: string) => {
  const r = await scanRepo(memRepoFs(files), { repoKey, now: 1 });
  expect(Check(RunProfile, r.profile)).toBe(true);
  return r;
};
const TAURI_READY = { kind: "log", pattern: "(Local:|ready in|Finished dev)" };

describe("scanRepo on the five repo shapes", () => {
  it("tide_reel: one Tauri app in gui/, fixed 1420 + hmr 1421, wrapped vite removed, pyproject without uvicorn ignored", async () => {
    const { profile, manifests } = await scan(tideReel, "tide_reel");
    expect(profile.services).toEqual([
      {
        id: "app",
        name: "Tauri app",
        cwd: "gui",
        command: "npm run tauri -- dev",
        listens: [
          { name: "http", port: 1420, how: "fixed" },
          { name: "hmr", port: 1421, how: "fixed" },
        ],
        connects: [],
        env: {},
        readiness: TAURI_READY,
        kind: "tauri",
      },
    ]);
    expect(profile.warnings).toEqual([]);
    expect(Object.keys(manifests).sort()).toEqual(["gui/package.json", "gui/src-tauri/tauri.conf.json", "gui/vite.config.js", "pyproject.toml"]);
  });

  it("tide_backend: api (venv, --port 8000, CLIENT_URL unresolved), celery after redis, Procfile ignored", async () => {
    const { profile, manifests } = await scan(tideBackend, "tide_backend");
    const venv = "source venv/bin/activate && ";
    const redisUrl = { env: "REDIS_URL", to: "tide_backend.redis", template: "redis://localhost:${port}" };
    expect(profile.services).toEqual([
      {
        id: "api",
        name: "API (uvicorn)",
        command: `${venv}uvicorn app.main:app --reload --port 8000`,
        listens: [{ name: "http", port: 8000, how: "flag", flag: "--port" }],
        connects: [{ env: "CLIENT_URL", to: "?:8081", template: "http://localhost:${port}" }, redisUrl],
        env: {},
        readiness: { kind: "log", pattern: "Uvicorn running on" },
        kind: "uvicorn",
      },
      {
        id: "celery",
        name: "Celery worker",
        command: `${venv}celery -A app.celery_app.celery worker --loglevel=info`,
        listens: [],
        connects: [redisUrl],
        env: {},
        readiness: { kind: "none" },
        kind: "worker",
        dependsOn: ["redis"],
      },
      {
        id: "redis",
        name: "Redis",
        command: "redis-server",
        listens: [{ name: "redis", port: 6379, how: "flag", flag: "--port" }],
        connects: [],
        env: {},
        readiness: { kind: "port", listen: "redis" },
        kind: "worker",
      },
    ]);
    // override=True inside venv/ is not the repo's code
    expect(profile.warnings).toEqual([]);
    // .env is hashed but never handed out
    expect(Object.keys(manifests)).not.toContain(".env");
    expect(JSON.stringify(manifests)).not.toContain("hunter2");
  });

  it("tide_frontend: vite web on 8081 (not strict) with VITE_API_URL, node server on PORT 8081 default off, override warning", async () => {
    const { profile } = await scan(tideFrontend, "tide_frontend");
    const api = { env: "VITE_API_URL", to: "?:8000", template: "http://localhost:${port}" };
    expect(profile.services).toEqual([
      {
        id: "web",
        name: "Vite dev server",
        command: "npm run dev",
        listens: [{ name: "http", port: 8081, how: "flag", flag: "--port", flagStyle: "space", strictFlag: "--strictPort" }],
        connects: [api],
        env: {},
        readiness: { kind: "log", pattern: "(Local:|ready in)" },
        kind: "vite",
      },
      {
        id: "server",
        name: "Node server",
        command: "npm run start",
        listens: [{ name: "http", port: 8081, how: "env", envVar: "PORT" }],
        connects: [api],
        env: {},
        readiness: { kind: "port", listen: "http" },
        kind: "node",
        default: false,
      },
    ]);
    expect(profile.warnings).toEqual(["src/env.js loads .env with override — injected env is ignored for keys set there"]);
  });

  it("tide_pos2: root tauri:dev drives apps/desktop, sync listen from TIDE_SYNC_PORT, TIDE_DEV_BASE_URL unresolved", async () => {
    const { profile } = await scan(tidePos2, "tide_pos2");
    expect(profile.services).toEqual([
      {
        id: "app",
        name: "Tauri app",
        command: "pnpm tauri:dev",
        listens: [
          { name: "http", port: 1420, how: "fixed" },
          { name: "hmr", port: 1421, how: "fixed" },
          { name: "sync", port: 8080, how: "env", envVar: "TIDE_SYNC_PORT" },
        ],
        connects: [{ env: "TIDE_DEV_BASE_URL", to: "?:8000", template: "http://localhost:${port}" }],
        env: {},
        readiness: TAURI_READY,
        kind: "tauri",
      },
    ]);
  });

  it("tide_pos_app: expo metro via start:dev, default off, LAN ip becomes ${host}, inline # stripped", async () => {
    const { profile } = await scan(tidePosApp, "tide_pos_app");
    expect(profile.services).toEqual([
      {
        id: "metro",
        name: "Expo (Metro)",
        command: "npm run start:dev",
        listens: [{ name: "metro", port: 8081, how: "flag", flag: "--port" }],
        connects: [{ env: "DEV_SERVER_URL", to: "?:8000", template: "http://${host}:${port}" }],
        env: {},
        readiness: { kind: "log", pattern: "(Metro waiting|Waiting on http)" },
        kind: "expo",
        default: false,
      },
    ]);
  });

  it("hash is stable and follows manifest edits (including .env)", async () => {
    const a = await scan(tideFrontend, "tide_frontend");
    const b = await scan({ ...tideFrontend }, "tide_frontend");
    expect(a.profile.manifestHash).toBe(b.profile.manifestHash);
    const c = await scan({ ...tideFrontend, ".env": "PORT=9000\n" }, "tide_frontend");
    expect(c.profile.manifestHash).not.toBe(a.profile.manifestHash);
    const d = await scanRepo(memRepoFs(tideFrontend), { repoKey: "tide_frontend", grep: false });
    expect(d.profile.manifestHash).toBe(a.profile.manifestHash);
    expect(d.profile.warnings).toEqual([]);
  });
});

describe("scanner pieces", () => {
  it("repo keys", () => {
    expect(defaultRepoKey("/Users/x/tide_backend")).toBe("tide_backend");
    expect(defaultRepoKey("/x/My App.v2/")).toBe("my-app-v2");
    expect(defaultRepoKey("/x/__")).toBe("repo");
  });

  it("existingPortFlag", () => {
    expect(existingPortFlag("vite --port 3000 --host")).toEqual({ port: 3000, match: "--port 3000" });
    expect(existingPortFlag("vite --port=3001")).toEqual({ port: 3001, match: "--port=3001" });
    expect(existingPortFlag("vite --portal 3")).toBeUndefined();
  });

  it("vite: script --port wins over config; absent config → 5173", async () => {
    const files = { "package.json": JSON.stringify({ scripts: { dev: "vite --port 3000" } }), "vite.config.ts": "server: { port: 4000 }" };
    expect((await scan(files, "x")).profile.services[0]?.listens[0]?.port).toBe(3000);
    expect((await scan({ "package.json": JSON.stringify({ scripts: { dev: "vite" } }) }, "x")).profile.services[0]?.listens[0]?.port).toBe(5173);
    expect(viteServerPort("export default { server: { strictPort: true, port: 1420, hmr: { port: 1421 } } }")).toEqual({ port: 1420, strict: true });
  });

  it("package manager from the lockfile", async () => {
    const base = { "package.json": JSON.stringify({ scripts: { dev: "vite" } }) };
    expect((await scan({ ...base, "yarn.lock": "" }, "x")).profile.services[0]?.command).toBe("yarn dev");
    expect((await scan({ ...base, "pnpm-lock.yaml": "" }, "x")).profile.services[0]?.command).toBe("pnpm dev");
  });

  it("beforeDevCommand script name", () => {
    expect(wrappedScript("pnpm --filter @tide/shared build && pnpm dev")).toBe("dev");
    expect(wrappedScript("npm run dev")).toBe("dev");
    expect(wrappedScript("trunk serve")).toBeUndefined();
  });

  it("compose host ports become fixed listens", async () => {
    const text = `services:\n  db:\n    image: postgres\n    ports:\n      - "5432:5432"\n  web:\n    ports:\n      - 127.0.0.1:8080:80\n      - 9000\nvolumes:\n  x:\n`;
    expect(composePorts(text)).toEqual([
      { service: "db", port: 5432 },
      { service: "web", port: 8080 },
      { service: "web", port: 9000 },
    ]);
    const svc = (await scan({ "docker-compose.yml": text }, "x")).profile.services[0];
    expect(svc).toMatchObject({ id: "compose", command: "docker compose up", listens: [{ name: "db", port: 5432, how: "fixed" }, { name: "web", port: 8080, how: "fixed" }, { name: "web-2", port: 9000, how: "fixed" }] });
  });

  it("Procfile and Makefile fill gaps only", async () => {
    const proc = (await scan({ Procfile: "web: node index.js --port $PORT\nworker: node jobs.js\n" }, "x")).profile.services;
    expect(proc.map((s) => [s.id, s.kind, s.listens.map((l) => l.envVar)])).toEqual([
      ["worker", "worker", []],
      ["web", "other", ["PORT"]],
    ]);
    expect((await scan({ Makefile: "dev:\n\tgo run .\n" }, "x")).profile.services.map((s) => s.command)).toEqual(["make dev"]);
    const nothing = await scan({ "README.md": "hi" }, "x");
    expect(nothing.profile.services).toEqual([]);
    expect(nothing.profile.warnings[0]).toMatch(/no dev service/);
  });

  it("dotenv parsing and URL templates", () => {
    const env = parseDotenv(`A=1\nexport B="x # y"\nC=http://localhost:5000 # api\n# D=2\nE='q'\n`);
    expect([...env]).toEqual([["A", "1"], ["B", "x # y"], ["C", "http://localhost:5000"], ["E", "q"]]);
    expect(urlTemplate("ws://127.0.0.1:9001/socket")).toEqual({ port: 9001, template: "ws://127.0.0.1:${port}/socket" });
    expect(urlTemplate("http://${HOST}:8000")).toEqual({ port: 8000, template: "http://${host}:${port}" });
    expect(urlTemplate("https://api.example.com")).toBeUndefined();
  });

  it("infra *_PORT keys do not become listens; own-port URLs resolve inside the repo", async () => {
    const files = {
      "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
      ".env": "DB_PORT=5432\nVITE_PUBLIC_URL=http://localhost:5173/app\n",
    };
    const web = (await scan(files, "site")).profile.services[0];
    expect(web?.listens.map((l) => l.name)).toEqual(["http"]);
    expect(web?.connects).toEqual([{ env: "VITE_PUBLIC_URL", to: "site.web", template: "http://localhost:${port}/app" }]);
  });
});
