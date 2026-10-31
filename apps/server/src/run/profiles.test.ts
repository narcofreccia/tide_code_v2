import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CompletionRequest, CompletionResult, ProviderInstance, RunProfile, RunRepo, RunService } from "@tide/contracts";
import { SettingsStore } from "../settings.ts";
import { memRepoFs } from "./fsFacade.ts";
import { buildModelPrompt, maskEnv } from "./modelPrompt.ts";
import { clearProfileCache, inferWithModel, invalidate, loadRepoProfile, projectRepos, resolveConnects, RUN_JSON, type InferDeps } from "./profiles.ts";
import { writeQuickstart } from "./quickstart.ts";
import { scanRepo } from "./scan.ts";
import { tideBackend, tideFrontend, tidePos2, tidePosApp, tideReel } from "./testing/fixtures.ts";

const dirs: string[] = [];
afterEach(async () => {
  clearProfileCache();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repoOnDisk(name: string, files: Record<string, string>): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "tide-run-"));
  dirs.push(parent);
  const root = join(parent, name);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), text);
  }
  await mkdir(root, { recursive: true });
  return root;
}

describe("loadRepoProfile", () => {
  it("scans when nothing is stored and writes .tide/run.json", async () => {
    const root = await repoOnDisk("tide_frontend", tideFrontend);
    const loaded = await loadRepoProfile(root);
    expect(loaded.stale).toBe(false);
    expect(loaded.profile?.source).toBe("manifest");
    expect(loaded.profile?.repoKey).toBe("tide_frontend");
    const stored = JSON.parse(await readFile(join(root, RUN_JSON), "utf8")) as RunProfile;
    expect(stored.services.map((s) => s.id)).toEqual(["web", "server"]);
  });

  it("prefers .tide/run.json, and flags it stale when manifests change", async () => {
    const root = await repoOnDisk("tide_frontend", tideFrontend);
    await loadRepoProfile(root);
    const stored = JSON.parse(await readFile(join(root, RUN_JSON), "utf8")) as RunProfile;
    await writeFile(join(root, RUN_JSON), JSON.stringify({ ...stored, source: "user", services: [stored.services[0]] }));
    const again = await loadRepoProfile(root);
    expect(again.profile?.source).toBe("user");
    expect(again.profile?.services).toHaveLength(1);
    expect(again.stale).toBe(false);
    await writeFile(join(root, "vite.config.js"), "export default { server: { port: 9000 } }\n");
    const stale = await loadRepoProfile(root);
    expect(stale.stale).toBe(true);
    expect(stale.profile?.services).toHaveLength(1);
  });

  it("QUICKSTART block beats run.json; a broken block falls through with the error", async () => {
    const root = await repoOnDisk("tide_backend", tideBackend);
    const scanned = (await loadRepoProfile(root)).profile as RunProfile;
    const mine: RunProfile = { ...scanned, services: [scanned.services[0] as RunService], manifestHash: "" };
    await writeFile(join(root, "QUICKSTART.md"), writeQuickstart("# Backend\n", mine));
    invalidate(root);
    const fromQs = await loadRepoProfile(root);
    expect(fromQs.profile?.source).toBe("quickstart");
    expect(fromQs.profile?.services.map((s) => s.id)).toEqual(["api"]);
    expect(fromQs.stale).toBe(false);
    await writeFile(join(root, "QUICKSTART.md"), "# Backend\n\n```tide-run\n{ nope\n```\n");
    const broken = await loadRepoProfile(root);
    expect(broken.profile?.source).toBe("manifest");
    expect(broken.error).toMatch(/^QUICKSTART\.md line 4: invalid JSON/);
  });

  it("caches by file stamps", async () => {
    const root = await repoOnDisk("tide_pos2", tidePos2);
    const a = await loadRepoProfile(root);
    expect(await loadRepoProfile(root)).toBe(a);
    invalidate(root);
    expect(await loadRepoProfile(root)).not.toBe(a);
  });

  it("missing path → error, no throw", async () => {
    const loaded = await loadRepoProfile(join(tmpdir(), "tide-run-does-not-exist-xyz"));
    expect(loaded).toEqual({ stale: false, error: expect.stringMatching(/path missing/) });
  });
});

const repo = async (repoId: string, repoKey: string, files: Record<string, string>): Promise<RunRepo> => ({
  repoId,
  repoKey,
  path: `/x/${repoKey}`,
  label: repoKey,
  stale: false,
  profile: (await scanRepo(memRepoFs(files), { repoKey, now: 1 })).profile,
});

describe("resolveConnects", () => {
  it("resolves the five-repo stack the way the plan expects", async () => {
    const repos = [
      await repo("root", "tide_frontend", tideFrontend),
      await repo("l1", "tide_backend", tideBackend),
      await repo("l2", "tide_pos2", tidePos2),
      await repo("l3", "tide_pos_app", tidePosApp),
      await repo("l4", "tide_reel", tideReel),
    ];
    const before = JSON.stringify(repos);
    const out = resolveConnects(repos);
    expect(JSON.stringify(repos)).toBe(before);
    const connects = (key: string, svc: string) => out.find((r) => r.repoKey === key)?.profile?.services.find((s) => s.id === svc)?.connects.map((c) => `${c.env}→${c.to}`);
    expect(connects("tide_frontend", "web")).toEqual(["VITE_API_URL→tide_backend.api"]);
    // three listeners on 8081 in other repos; only frontend.web is on by default
    expect(connects("tide_backend", "api")).toEqual(["CLIENT_URL→tide_frontend.web", "REDIS_URL→tide_backend.redis"]);
    expect(connects("tide_pos2", "app")).toEqual(["TIDE_DEV_BASE_URL→tide_backend.api"]);
    expect(connects("tide_pos_app", "metro")).toEqual(["DEV_SERVER_URL→tide_backend.api"]);
    expect(out.flatMap((r) => r.profile?.warnings ?? [])).toEqual(["src/env.js loads .env with override — injected env is ignored for keys set there"]);
  });

  it("unmatched and ambiguous connects stay and warn", async () => {
    const backendAlone = resolveConnects([await repo("root", "tide_backend", tideBackend)]);
    expect(backendAlone[0]?.profile?.services[0]?.connects[0]?.to).toBe("?:8081");
    expect(backendAlone[0]?.profile?.warnings).toEqual(["CLIENT_URL on tide_backend.api: no service in this stack listens on 8081"]);
    const twoWebs = resolveConnects([
      await repo("root", "tide_backend", tideBackend),
      await repo("a", "web_a", { "package.json": JSON.stringify({ scripts: { dev: "vite --port 8081" } }) }),
      await repo("b", "web_b", { "package.json": JSON.stringify({ scripts: { dev: "vite --port 8081" } }) }),
    ]);
    expect(twoWebs[0]?.profile?.warnings[0]).toBe("CLIENT_URL on tide_backend.api: port 8081 is claimed by web_a.web, web_b.web; pick one in the profile");
  });
});

describe("projectRepos", () => {
  it("root first, then links", () => {
    const model = { projects: { p: { id: "p", title: "Frontend", rootPath: "/f", links: [{ id: "l1", path: "/b", label: "Backend", access: "read" }] } } } as never;
    expect(projectRepos(model, "p")).toEqual([
      { repoId: "root", path: "/f", label: "Frontend" },
      { repoId: "l1", path: "/b", label: "Backend" },
    ]);
    expect(projectRepos(model, "nope")).toBeUndefined();
  });
});

describe("inferWithModel", () => {
  const service: RunService = { id: "api", name: "API", command: "go run .", listens: [{ name: "http", port: 8080, how: "env", envVar: "PORT" }], connects: [], env: {}, readiness: { kind: "port" } };

  function deps(answer: string) {
    const requests: CompletionRequest[] = [];
    const instance = { kind: "claude", complete: async (r: CompletionRequest): Promise<CompletionResult> => (requests.push(r), { text: answer, elapsedMs: 1 }) } as unknown as ProviderInstance;
    const registry = { has: () => true, get: async () => instance, status: async () => ({}), statusAll: async () => [{ kind: "claude", caps: { oneShot: true } }] } as unknown as InferDeps["registry"];
    return { requests, deps: { registry, settings: new SettingsStore(), tideHome: dirs[0] ?? tmpdir() } satisfies InferDeps };
  }

  it("fills the envelope around the model's services and uses the documented budget", async () => {
    const files = { "go.mod": "module x\n", "README.md": "# X\n" + "r".repeat(5000), ".env.example": "PORT=8080\nAPI_KEY=secret\nUP=http://localhost:9000\n" };
    const { deps: d, requests } = deps(`{"services": [${JSON.stringify(service)}, ${JSON.stringify(service)}], "warnings": ["needs Go 1.23"]}`);
    const profile = await inferWithModel("/x/goapp", d, { fs: memRepoFs(files), now: 5 });
    expect(profile).toMatchObject({ version: 1, repoKey: "goapp", source: "model", generatedAt: 5, services: [service], warnings: ["needs Go 1.23"] });
    expect(requests[0]?.system).toMatch(/^You describe how to run a repository for local development\. Return exactly one JSON object matching this JSON Schema, nothing else:\n\{/);
    expect(requests[0]).toMatchObject({ maxOutputTokens: 2000, timeoutMs: 40_000 });
    expect(requests[0]?.cwd.endsWith("/run")).toBe(true);
    const prompt = requests[0]?.prompt ?? "";
    expect(prompt).toContain("go.mod");
    expect(prompt).toContain("--- .env.example ---\nPORT=8080\nAPI_KEY=***\nUP=http://localhost:9000");
    expect(prompt).not.toContain("secret");
    expect(prompt).toContain("--- README.md (head) ---");
    expect(prompt).not.toContain("r".repeat(1600));
  });

  it("prompt stays within 24 KB", async () => {
    const files: Record<string, string> = { "package.json": JSON.stringify({ scripts: { dev: "vite" }, x: "p".repeat(10_000) }) };
    for (let i = 0; i < 400; i++) files[`src/f${i}.ts`] = "";
    const fs = memRepoFs(files);
    const scan = await scanRepo(fs, { repoKey: "big" });
    const prompt = await buildModelPrompt(fs, "big", scan.manifests);
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(24 * 1024);
    expect(prompt).toContain("(truncated)");
    expect(maskEnv("A=\nB=ws://0.0.0.0:1\nC=x")).toBe("A=\nB=ws://0.0.0.0:1\nC=***");
  });

  it("model failure surfaces as conflict", async () => {
    const { deps: d } = deps("I cannot help");
    await expect(inferWithModel("/x/goapp", d, { fs: memRepoFs({}) })).rejects.toMatchObject({ code: "conflict" });
  });
});
