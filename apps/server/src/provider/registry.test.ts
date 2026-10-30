import type { ProviderInstance, ProviderInstanceConfig } from "@tide/contracts";
import { describe, expect, it } from "vitest";
import { createInstanceFactory } from "./instances.ts";
import { DriverRegistry } from "./registry.ts";
import { createFakeDriver, type FakeDriverHandle } from "./testing/fakeDriver.ts";

const env = { dataDir: ":memory:", log: () => undefined };

describe("DriverRegistry", () => {
  it("lists registered default instances and reports their status", async () => {
    const { driver, control } = createFakeDriver("claude");
    const registry = new DriverRegistry({ env });
    registry.register(driver);
    expect(registry.list()).toEqual(["claude"]);
    expect(registry.has("codex")).toBe(false);
    const [status] = await registry.statusAll();
    expect(status).toMatchObject({ kind: "claude", installed: true, loggedIn: true, models: [{ id: "fake-model" }] });
    expect(status?.caps.planMode).toBe(true);
    expect(control.statusResult.kind).toBe("claude");
  });

  it("caches status for 60s and refreshes on demand", async () => {
    const clock = { t: 0 };
    const { driver, control } = createFakeDriver("claude");
    const registry = new DriverRegistry({ env, now: () => clock.t });
    registry.register(driver);
    await registry.statusAll();
    control.statusResult = { ...control.statusResult, loggedIn: false };

    clock.t = 59_000;
    expect((await registry.statusAll())[0]?.loggedIn).toBe(true);
    expect((await registry.statusAll(true))[0]?.loggedIn).toBe(false);

    control.statusResult = { ...control.statusResult, loggedIn: true };
    clock.t = 200_000;
    expect((await registry.statusAll())[0]?.loggedIn).toBe(true);
  });

  it("turns a failing status() into an unusable entry instead of throwing", async () => {
    const { driver, control } = createFakeDriver("claude");
    control.statusError = new Error("claude: command not found");
    const registry = new DriverRegistry({ env });
    registry.register(driver);
    const [status] = await registry.statusAll();
    expect(status).toEqual({
      id: "claude",
      kind: "claude",
      label: "Claude Code",
      installed: false,
      loggedIn: false,
      hint: "claude: command not found",
      models: [],
      caps: { planMode: false, subagents: false, mcp: false, images: false, resume: false, contextUsage: false, openInTerminal: false },
    });
  });

  it("turns a failing create() into an unusable entry and retries later", async () => {
    const { driver, control } = createFakeDriver("claude");
    control.createError = new Error("spawn failed");
    const registry = new DriverRegistry({ env, ttlMs: 0 });
    registry.register(driver);
    expect((await registry.statusAll())[0]).toMatchObject({ installed: false, hint: "spawn failed" });
    control.createError = undefined;
    expect((await registry.statusAll())[0]).toMatchObject({ installed: true });
  });

  it("throws when asked for an unregistered kind", async () => {
    const registry = new DriverRegistry({ env });
    await expect(registry.get("pi")).rejects.toThrow("no driver registered for pi");
  });
});

describe("DriverRegistry instances (R8)", () => {
  const work: ProviderInstanceConfig = { id: "codex:work", kind: "codex", label: "Codex (work)", env: { OPENAI_ORG: "work" } };
  const personal: ProviderInstanceConfig = { id: "codex:personal", kind: "codex", label: "Codex (personal)", env: { OPENAI_ORG: "me" } };

  function setup(): { registry: DriverRegistry; codex: FakeDriverHandle; acp: FakeDriverHandle; busy: Set<ProviderInstance>; logs: string[] } {
    const claude = createFakeDriver("claude");
    const codex = createFakeDriver("codex");
    const acp = createFakeDriver("acp");
    const logs: string[] = [];
    const registry = new DriverRegistry({ env: { dataDir: ":memory:", log: (msg) => logs.push(msg) } });
    registry.register(claude.driver);
    registry.register(codex.driver);
    registry.setFactory(createInstanceFactory({ providers: {}, acp: { find: () => undefined }, drivers: { codex: codex.driver, acp: acp.driver } }));
    const busy = new Set<ProviderInstance>();
    registry.setInUse((instance) => busy.has(instance));
    return { registry, codex, acp, busy, logs };
  }

  it("runs two instances of one kind, each with its own env and identity", async () => {
    const { registry, codex } = setup();
    await registry.syncInstances([work, personal]);
    const a = await registry.get("codex:work");
    const b = await registry.get("codex:personal");
    expect(a).not.toBe(b);
    expect(registry.kindOf("codex:work")).toBe("codex");
    const envs = codex.control.created.map((c) => ({ instance: c.env.instance, env: c.config["env"] }));
    expect(envs).toEqual([
      { instance: { id: "codex:work", label: "Codex (work)", env: { OPENAI_ORG: "work" } }, env: { OPENAI_ORG: "work" } },
      { instance: { id: "codex:personal", label: "Codex (personal)", env: { OPENAI_ORG: "me" } }, env: { OPENAI_ORG: "me" } },
    ]);
  });

  it("maps home onto each harness's own account variable", async () => {
    const { registry, codex } = setup();
    await registry.syncInstances([{ ...work, home: "/accounts/codex-work" }]);
    await registry.get("codex:work");
    const created = codex.control.created[0];
    expect(created?.config).toMatchObject({ codexHome: "/accounts/codex-work", env: { CODEX_HOME: "/accounts/codex-work", OPENAI_ORG: "work" } });
    expect(created?.env.instance).toMatchObject({ home: "/accounts/codex-work" });
  });

  it("starts an ACP instance from a manual command", async () => {
    const { registry, acp } = setup();
    await registry.syncInstances([{ id: "acp:local", kind: "acp", label: "My agent", command: "/usr/local/bin/agent", args: ["--acp"], env: { K: "v" } }]);
    await registry.get("acp:local");
    expect(acp.control.created[0]?.config).toMatchObject({ command: "/usr/local/bin/agent", args: ["--acp"], env: { K: "v" }, label: "My agent" });
  });

  it("reports an ACP agent it cannot launch as unusable instead of failing the list", async () => {
    const { registry } = setup();
    await registry.syncInstances([{ id: "acp:ghost", kind: "acp", label: "Ghost", acpAgentId: "ghost" }]);
    const dto = await registry.status("acp:ghost");
    expect(dto).toMatchObject({ id: "acp:ghost", kind: "acp", label: "Ghost", installed: false });
    expect(dto.hint).toContain("not in the registry");
  });

  it("lists defaults first (canonical order, labelled) then user instances in settings order", async () => {
    const { registry } = setup();
    await registry.syncInstances([personal, work]);
    const all = await registry.statusAll();
    expect(all.map((d) => [d.id, d.kind, d.label])).toEqual([
      ["claude", "claude", "Claude Code"],
      ["codex", "codex", "Codex"],
      ["opencode", "opencode", "OpenCode"],
      ["pi", "pi", "Pi"],
      ["codex:personal", "codex", "Codex (personal)"],
      ["codex:work", "codex", "Codex (work)"],
    ]);
    expect(all[2]).toMatchObject({ installed: false, hint: "driver not available in this build" });
    await registry.syncInstances([work, personal]);
    expect((await registry.statusAll()).slice(4).map((d) => d.id)).toEqual(["codex:work", "codex:personal"]);
  });

  it("keeps an unchanged instance, replaces a changed one and removes a dropped one", async () => {
    const { registry, codex } = setup();
    await registry.syncInstances([work, personal]);
    const first = await registry.get("codex:work");
    const firstPersonal = await registry.get("codex:personal");
    await registry.syncInstances([work, { ...personal, env: { OPENAI_ORG: "me2" } }]);
    expect(await registry.get("codex:work")).toBe(first);
    expect(await registry.get("codex:personal")).not.toBe(firstPersonal);
    expect(codex.control.disposed).toEqual([firstPersonal]);
    await registry.syncInstances([personal]);
    expect(registry.has("codex:work")).toBe(false);
    expect(codex.control.disposed).toContain(first);
    await expect(registry.get("codex:work")).rejects.toThrow("no driver registered for codex:work");
  });

  it("defers disposing a removed instance while a session still runs on it", async () => {
    const { registry, codex, busy, logs } = setup();
    await registry.syncInstances([work]);
    const live = await registry.get("codex:work");
    busy.add(live);
    await registry.syncInstances([]);
    expect(registry.has("codex:work")).toBe(false);
    expect(codex.control.disposed).toEqual([]);
    expect(logs.some((l) => l.includes("disposal deferred"))).toBe(true);
    busy.delete(live);
    await registry.sweepRetired();
    expect(codex.control.disposed).toEqual([live]);
  });

  it("ignores a settings id that shadows a bundled kind", async () => {
    const { registry, codex } = setup();
    await registry.syncInstances([{ id: "codex", kind: "codex", label: "Shadow" }]);
    expect(registry.labelOf("codex")).toBe("Codex");
    expect(codex.control.created).toEqual([]);
  });
});
