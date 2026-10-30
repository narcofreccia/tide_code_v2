import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyReadModel, type ClientCommand, type EnvProbe, type ReadModel, type Thread } from "@tide/contracts";
import type { FetchLike } from "@tide/client";
import { FakeEnvConnection, flushMicrotasks, installFakeConnections } from "./fakeEnvConnection.ts";
import { resetEnvManager, setEnvFetch, startEnvironments } from "./envManager.ts";
import { ENVIRONMENTS_KEY, loadEnvironments } from "./envPersist.ts";
import {
  addEnvironment,
  envOfProject,
  envOfThread,
  environmentName,
  pairWithCode,
  removeEnvironment,
  setPrimaryEnvironment,
  updateEnvironment,
  useEnvironments,
} from "./environments.ts";
import { call, dispatch, stream, useModel } from "./model.ts";
import { providerStatus, resetProviders, useProvidersStore, type EnvProviderStatus } from "./providers.ts";
import { resetServerSettings } from "./serverSettings.ts";

const LOCAL_URL = "ws://127.0.0.1:3777/ws";

function thread(id: string, projectId: string): Thread {
  return { id, projectId, title: id, provider: "claude", mode: "approval-required", interaction: "default", status: "idle", createdAt: 1, updatedAt: 1 };
}

function modelWith(projectId: string, threadIds: string[], extra: Partial<ReadModel> = {}): ReadModel {
  const m = emptyReadModel();
  m.seq = 5;
  m.projects[projectId] = { id: projectId, title: projectId, rootPath: `/${projectId}`, createdAt: 1, updatedAt: 1 };
  for (const id of threadIds) m.threads[id] = thread(id, projectId);
  return { ...m, ...extra };
}

function probeFetch(table: Record<string, EnvProbe>, pair?: { status: number; body?: unknown }): FetchLike & { posts: { url: string; body?: string }[] } {
  const posts: { url: string; body?: string }[] = [];
  const fn = (async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST") {
      posts.push({ url, ...(init.body === undefined ? {} : { body: init.body }) });
      return { ok: (pair?.status ?? 200) < 300, status: pair?.status ?? 200, json: async () => pair?.body ?? {} };
    }
    const probe = table[new URL(url).origin];
    if (!probe) throw new TypeError("fetch failed");
    return { ok: true, status: 200, json: async () => probe };
  }) as FetchLike & { posts: { url: string; body?: string }[] };
  fn.posts = posts;
  return fn;
}

const probe = (environmentId: string, name = environmentId): EnvProbe => ({ environmentId, name, version: "1", protocol: 1 });

let fakes: ReturnType<typeof installFakeConnections>;

/** local env "env-L" (rekeyed from the provisional id) + remote "env-R", both connected with a model. */
async function twoEnvironments(): Promise<{ local: FakeEnvConnection; remote: FakeEnvConnection }> {
  startEnvironments({ url: LOCAL_URL, token: "tok-l" });
  const local = fakes.byId("local");
  local.emit({ state: "connected", environmentId: "env-L", route: { kind: "local", url: LOCAL_URL, priority: 0 } });
  setEnvFetch(probeFetch({ "http://10.0.0.7:3777": probe("env-R", "studio") }));
  await addEnvironment({ routes: [{ kind: "lan", url: "ws://10.0.0.7:3777/ws", priority: 10 }], token: "tok-r" });
  const remote = fakes.byId("env-R");
  remote.emit({ state: "connected", environmentId: "env-R" });
  local.setModel(modelWith("pL", ["tL"]));
  remote.setModel(modelWith("pR", ["tR"], {
    turns: { uR: { id: "uR", threadId: "tR", status: "completed", requestedAt: 1 } },
    plans: { planR: { id: "planR", threadId: "tR", turnId: "uR", markdown: "x", status: "proposed", createdAt: 1, updatedAt: 1 } },
  }));
  await flushMicrotasks();
  local.calls.length = 0;
  remote.calls.length = 0;
  return { local, remote };
}

beforeEach(() => {
  window.localStorage.clear();
  resetEnvManager();
  resetProviders();
  resetServerSettings();
  fakes = installFakeConnections();
});
afterEach(() => {
  resetEnvManager();
});

describe("environment routing", () => {
  it("merges both read models and records ownership", async () => {
    await twoEnvironments();
    const { model, ownership } = useModel.getState();
    expect(Object.keys(model.threads).sort()).toEqual(["tL", "tR"]);
    expect(ownership.threads).toEqual({ tL: "env-L", tR: "env-R" });
    expect(envOfThread("tR")).toBe("env-R");
    expect(envOfProject("pL")).toBe("env-L");
    expect(useEnvironments.getState().primaryId).toBe("env-L");
  });

  it("routes calls: explicit env > owner of the thread / project > primary", async () => {
    const { local, remote } = await twoEnvironments();
    remote.handlers["vcs.status"] = () => ({});
    await call("vcs.status", { threadId: "tR" });
    await call("settings.get", {}).catch(() => undefined);
    await call("fs.browse", {}, { envId: "env-R" }).catch(() => undefined);
    await call("vcs.status", { threadId: "unknown-thread" }).catch(() => undefined);
    expect(remote.calls.map((c) => c.method)).toEqual(["vcs.status", "fs.browse"]);
    expect(local.calls.map((c) => c.method)).toEqual(["settings.get", "vcs.status"]);
  });

  it("routes commands by threadId, projectId (new thread), planId, turnId; else the primary", async () => {
    const { local, remote } = await twoEnvironments();
    const cmd = (c: Record<string, unknown>): ClientCommand => ({ commandId: "c", ...c }) as unknown as ClientCommand;
    await dispatch(cmd({ type: "turn.interrupt", threadId: "tR" }));
    await dispatch(cmd({ type: "thread.create", projectId: "pR", provider: "claude" }));
    await dispatch(cmd({ type: "plan.dismiss", planId: "planR" }));
    await dispatch(cmd({ type: "turn.dequeue", turnId: "uR" }));
    await dispatch(cmd({ type: "project.create", title: "x", rootPath: "/x" }));
    await dispatch(cmd({ type: "turn.interrupt", threadId: "tL" }));
    await dispatch(cmd({ type: "turn.interrupt", threadId: "tL" }), { envId: "env-R" });
    expect(remote.dispatched.map((c) => c.type)).toEqual(["turn.interrupt", "thread.create", "plan.dismiss", "turn.dequeue", "turn.interrupt"]);
    expect(local.dispatched.map((c) => c.type)).toEqual(["project.create", "turn.interrupt"]);
  });

  it("follows a pty to the environment that created it, and routes streams like calls", async () => {
    const { local, remote } = await twoEnvironments();
    remote.handlers["pty.create"] = () => ({ ptyId: "pty-9" });
    await call("pty.create", { threadId: "tR", cols: 80, rows: 24 });
    await call("pty.write", { ptyId: "pty-9", data: "ls" }).catch(() => undefined);
    stream("pty.attach", { ptyId: "pty-9" }, () => undefined);
    stream("fs.watch", { threadId: "tL" }, () => undefined);
    stream("env.updateHarnesses", {}, () => undefined, { envId: "env-R" });
    expect(remote.calls.map((c) => c.method)).toEqual(["pty.create", "pty.write"]);
    expect(remote.streams.map((s) => s.method)).toEqual(["pty.attach", "env.updateHarnesses"]);
    expect(local.streams.map((s) => s.method)).toEqual(["fs.watch"]);
  });

  it("switching the primary moves environment-less calls and the status mirror", async () => {
    const { remote } = await twoEnvironments();
    setPrimaryEnvironment("env-R");
    await call("decisions.stats", {}).catch(() => undefined);
    expect(remote.calls.some((c) => c.method === "decisions.stats")).toBe(true);
    expect(useModel.getState().environmentId).toBe("env-R");
    expect(useModel.getState().status).toBe("open");
    expect(loadEnvironments()?.primaryId).toBe("env-R");
  });

  it("removal disconnects, drops the model and the ownership", async () => {
    const { remote } = await twoEnvironments();
    removeEnvironment("env-R");
    await flushMicrotasks();
    expect(remote.stopped).toBe(true);
    expect(Object.keys(useModel.getState().model.threads)).toEqual(["tL"]);
    expect(envOfThread("tR")).toBeUndefined();
    expect(useEnvironments.getState().environments.map((e) => e.id)).toEqual(["env-L"]);
    expect(() => removeEnvironment("env-L")).toThrow(/local/);
  });

  it("persists ownership so routing works before the snapshot arrives", async () => {
    await twoEnvironments();
    resetEnvManager();
    fakes = installFakeConnections();
    startEnvironments({ url: LOCAL_URL, token: "tok-l" });
    const remote = fakes.byId("env-R");
    remote.emit({ state: "connected" });
    await call("vcs.status", { threadId: "tR" }).catch(() => undefined);
    expect(remote.calls.map((c) => c.method)).toContain("vcs.status");
  });

  it("unions the provider rosters, tagged by environment, primary first", async () => {
    startEnvironments({ url: LOCAL_URL, token: "" });
    const local = fakes.byId("local");
    local.handlers["providers.list"] = () => [{ id: "claude", kind: "claude", label: "Claude", installed: true, loggedIn: true, models: [], caps: {} }];
    local.emit({ state: "connected", environmentId: "env-L" });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(useProvidersStore.getState().providers.map((p) => [p.id, p.envId])).toEqual([["claude", "env-L"]]);
  });
});

describe("providerStatus", () => {
  it("picks an environment's own entry when asked, the first (primary) otherwise", () => {
    const entry = (envId: string, installed: boolean): EnvProviderStatus =>
      ({ id: "codex", kind: "codex", label: "Codex", installed, loggedIn: true, models: [], caps: {}, envId }) as unknown as EnvProviderStatus;
    const roster = [entry("env-L", true), entry("env-R", false)];
    expect(providerStatus(roster, "codex")?.envId).toBe("env-L");
    expect(providerStatus(roster, "codex", "env-R")?.installed).toBe(false);
    expect(providerStatus(roster, "codex", "env-X")).toBeUndefined();
  });
});

describe("adding and pairing", () => {
  it("probes the routes, takes the id that answers, and merges a known environment", async () => {
    startEnvironments({ url: LOCAL_URL, token: "" });
    setEnvFetch(probeFetch({ "https://studio.tail1.ts.net": probe("env-R", "studio") }));
    const id = await addEnvironment({ routes: [{ kind: "tailscale", url: "wss://studio.tail1.ts.net/ws", priority: 20 }] });
    expect(id).toBe("env-R");
    expect(environmentName("env-R")).toBe("studio");
    const again = await addEnvironment({ routes: [{ kind: "tailscale", url: "wss://studio.tail1.ts.net/ws", priority: 20 }], token: "t2" });
    expect(again).toBe("env-R");
    expect(useEnvironments.getState().environments.filter((e) => e.id === "env-R")).toHaveLength(1);
    expect(fakes.byId("env-R").tokens).toEqual(["t2"]);
  });

  it("refuses when no route answers", async () => {
    startEnvironments({ url: LOCAL_URL, token: "" });
    setEnvFetch(probeFetch({}));
    await expect(addEnvironment({ routes: [{ kind: "lan", url: "ws://10.0.0.9:1/ws", priority: 10 }] })).rejects.toThrow(/No route answered/);
  });

  it("pairs with a code: POSTs it, stores the token and a route by host kind", async () => {
    startEnvironments({ url: LOCAL_URL, token: "" });
    const fetchImpl = probeFetch({}, { status: 200, body: { environmentId: "env-P", name: "laptop", token: "secret" } });
    setEnvFetch(fetchImpl);
    const id = await pairWithCode("http://192.168.1.20:3777", " 123456 ");
    expect(id).toBe("env-P");
    expect(fetchImpl.posts).toEqual([{ url: "http://192.168.1.20:3777/api/auth/pair", body: JSON.stringify({ code: "123456" }) }]);
    const env = useEnvironments.getState().environments.find((e) => e.id === "env-P");
    expect(env).toMatchObject({ name: "laptop", token: "secret", routes: [{ kind: "lan", url: "ws://192.168.1.20:3777/ws" }] });
    expect(fakes.byId("env-P").opts.token).toBe("secret");
    expect(JSON.parse(window.localStorage.getItem(ENVIRONMENTS_KEY)!).environments.some((e: { id: string }) => e.id === "env-P")).toBe(true);
  });

  it("derives tailscale / custom routes and wss for https", async () => {
    startEnvironments({ url: LOCAL_URL, token: "" });
    setEnvFetch(probeFetch({}, { status: 200, body: { environmentId: "env-T", name: "t", token: "x" } }));
    await pairWithCode("https://box.tail9.ts.net", "1");
    setEnvFetch(probeFetch({}, { status: 200, body: { environmentId: "env-C", name: "c", token: "x" } }));
    await pairWithCode("https://tide.example.com", "1");
    const routes = Object.fromEntries(useEnvironments.getState().environments.map((e) => [e.id, e.routes[0]]));
    expect(routes["env-T"]).toMatchObject({ kind: "tailscale", url: "wss://box.tail9.ts.net/ws" });
    expect(routes["env-C"]).toMatchObject({ kind: "custom", url: "wss://tide.example.com/ws" });
  });

  it("surfaces a refused code", async () => {
    startEnvironments({ url: LOCAL_URL, token: "" });
    setEnvFetch(probeFetch({}, { status: 401 }));
    await expect(pairWithCode("http://10.0.0.2:3777", "000000")).rejects.toThrow(/refused/);
  });

  it("updates routes on the live connection", async () => {
    await twoEnvironments();
    updateEnvironment("env-R", { name: "studio-2", routes: [{ kind: "custom", url: "wss://r.example/ws", priority: 40 }] });
    expect(fakes.byId("env-R").routes).toEqual([{ kind: "custom", url: "wss://r.example/ws", priority: 40 }]);
    expect(environmentName("env-R")).toBe("studio-2");
  });
});

describe("statuses", () => {
  it("mirrors each connection into useEnvironments().statuses", async () => {
    await twoEnvironments();
    fakes.byId("env-R").emit({ state: "unauthorized", error: "unauthorized" });
    expect(useEnvironments.getState().statuses["env-R"]).toMatchObject({ connection: "unauthorized", error: "unauthorized" });
    // only the primary drives the app-wide status
    expect(useModel.getState().status).toBe("open");
    fakes.byId("local").emit({ state: "offline", error: "connection lost" });
    expect(useModel.getState().status).toBe("reconnecting");
    expect(useModel.getState().lastError).toBe("connection lost");
  });
});
