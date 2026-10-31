import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CompletionResult, ProviderInstance, RpcFrame, RunProfile, RunRepo } from "@tide/contracts";
import { Engine } from "../orchestration/engine.ts";
import { openEventStore } from "../orchestration/store.ts";
import { clearProfileCache, RUN_JSON } from "../run/profiles.ts";
import { tideBackend, tideFrontend } from "../run/testing/fixtures.ts";
import { SettingsStore } from "../settings.ts";
import { RpcRouter } from "./router.ts";
import { registerRunProfileHandlers, type RunProfileDeps } from "./run.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  clearProfileCache();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), text);
  }
}

async function setup(complete: () => Promise<CompletionResult> = () => Promise.reject(new Error("model offline"))) {
  const parent = await mkdtemp(join(tmpdir(), "tide-rpc-run-"));
  cleanups.push(() => rm(parent, { recursive: true, force: true }));
  const frontend = join(parent, "tide_frontend");
  const backend = join(parent, "tide_backend");
  await write(frontend, tideFrontend);
  await write(backend, tideBackend);
  const store = await openEventStore(":memory:");
  cleanups.push(async () => store.close());
  const engine = new Engine({ store });
  const created = (await engine.dispatch({ type: "project.create", title: "Frontend", rootPath: frontend })).events[0]?.event;
  if (created?.type !== "project.created") throw new Error("expected project.created");
  const projectId = created.project.id;
  await engine.dispatch({ type: "project.link.add", projectId, path: backend, label: "Backend" });
  await engine.dispatch({ type: "project.link.add", projectId, path: join(parent, "gone"), label: "Gone" });
  const links = engine.getModel().projects[projectId]?.links ?? [];
  const instance = { kind: "claude", complete } as unknown as ProviderInstance;
  const registry = { has: () => true, get: async () => instance, status: async () => ({}), statusAll: async () => [{ kind: "claude", caps: { oneShot: true } }] } as unknown as RunProfileDeps["registry"];
  const router = new RpcRouter();
  registerRunProfileHandlers(router, { engine, registry, settings: new SettingsStore(), tideHome: parent });
  const frames: RpcFrame[] = [];
  const connection = router.connection("c1", (frame) => frames.push(frame));
  let seq = 0;
  const call = async <T,>(method: string, params: unknown): Promise<{ result?: T; error?: { code: string; message: string } }> => {
    const id = `r${++seq}`;
    await connection.handleRequest(id, method, params);
    const frame = frames.find((f) => f.id === id);
    if (frame && "result" in frame) return { result: frame.result as T };
    if (frame && "error" in frame) return { error: frame.error };
    throw new Error(`no frame for ${method}`);
  };
  return { call, projectId, frontend, backend, backendId: links[0]?.id as string, goneId: links[1]?.id as string };
}

describe("run.profiles.*", () => {
  it("get: root + links, cross-resolved, a missing path is an error row", async () => {
    const s = await setup();
    const { result } = await s.call<{ repos: RunRepo[] }>("run.profiles.get", { projectId: s.projectId });
    expect(result?.repos.map((r) => [r.repoId === "root" ? "root" : r.label, r.repoKey, r.profile?.source, r.error === undefined])).toEqual([
      ["root", "tide_frontend", "manifest", true],
      ["Backend", "tide_backend", "manifest", true],
      ["Gone", "gone", undefined, false],
    ]);
    expect(result?.repos[2]?.error).toMatch(/path missing/);
    expect(result?.repos[0]?.profile?.services[0]?.connects[0]?.to).toBe("tide_backend.api");
    expect(result?.repos[1]?.profile?.services[0]?.connects[0]?.to).toBe("tide_frontend.web");
    expect(await readFile(join(s.backend, RUN_JSON), "utf8")).toContain('"repoKey": "tide_backend"');
    expect((await s.call("run.profiles.get", { projectId: "nope" })).error?.code).toBe("not-found");
  });

  it("scan with a failing model falls back to the scan and says why", async () => {
    const s = await setup();
    const { result } = await s.call<RunRepo>("run.profiles.scan", { projectId: s.projectId, repoId: s.backendId, useModel: true });
    expect(result?.profile?.source).toBe("manifest");
    expect(result?.profile?.warnings).toContain("model: model offline");
    expect(result?.profile?.services[0]?.connects[0]?.to).toBe("tide_frontend.web");
    expect((await s.call("run.profiles.scan", { projectId: s.projectId, repoId: s.goneId })).error?.code).toBe("not-found");
  });

  it("scan with a working model stores source model", async () => {
    const answer = JSON.stringify({ services: [{ id: "api", name: "API", command: "make api", listens: [{ name: "http", port: 8000, how: "env", envVar: "PORT" }], connects: [], env: {}, readiness: { kind: "port" } }] });
    const s = await setup(() => Promise.resolve({ text: answer, elapsedMs: 1 }));
    const { result } = await s.call<RunRepo>("run.profiles.scan", { projectId: s.projectId, repoId: s.backendId, useModel: true });
    expect(result?.profile?.source).toBe("model");
    expect(result?.profile?.services.map((x) => x.command)).toEqual(["make api"]);
    expect((JSON.parse(await readFile(join(s.backend, RUN_JSON), "utf8")) as RunProfile).source).toBe("model");
  });

  it("set stores source user with the current hash; invalid profiles are rejected", async () => {
    const s = await setup();
    const got = (await s.call<{ repos: RunRepo[] }>("run.profiles.get", { projectId: s.projectId })).result?.repos[0]?.profile as RunProfile;
    const edited: RunProfile = { ...got, services: got.services.slice(0, 1), manifestHash: "old" };
    const { result } = await s.call<RunRepo>("run.profiles.set", { projectId: s.projectId, repoId: "root", profile: edited });
    expect(result?.profile?.source).toBe("user");
    expect(result?.profile?.manifestHash).toBe(got.manifestHash);
    const after = (await s.call<{ repos: RunRepo[] }>("run.profiles.get", { projectId: s.projectId })).result?.repos[0];
    expect(after?.profile?.source).toBe("user");
    expect(after?.stale).toBe(false);
    const bad = await s.call("run.profiles.set", { projectId: s.projectId, repoId: "root", profile: { ...edited, repoKey: "Bad Key" } });
    expect(bad.error?.code).toBe("invalid-params");
  });

  it("quickstart.write creates QUICKSTART.md, which then wins on get", async () => {
    const s = await setup();
    await writeFile(join(s.frontend, "QUICKSTART.md"), "# Frontend\n\nInstall Node 22.\n");
    const { result } = await s.call<{ path: string }>("run.quickstart.write", { projectId: s.projectId, repoId: "root" });
    expect(result?.path).toBe(join(s.frontend, "QUICKSTART.md"));
    const text = await readFile(join(s.frontend, "QUICKSTART.md"), "utf8");
    expect(text.startsWith("# Frontend\n\nInstall Node 22.\n\n## Run with Tide")).toBe(true);
    expect(text).toContain("```tide-run");
    const repos = (await s.call<{ repos: RunRepo[] }>("run.profiles.get", { projectId: s.projectId })).result?.repos;
    expect(repos?.[0]?.profile?.source).toBe("quickstart");
    expect(repos?.[0]?.stale).toBe(false);
  });
});
