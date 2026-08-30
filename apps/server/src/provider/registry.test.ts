import { describe, expect, it } from "vitest";
import { DriverRegistry } from "./registry.ts";
import { createFakeDriver } from "./testing/fakeDriver.ts";

const env = { dataDir: ":memory:", log: () => undefined };

describe("DriverRegistry", () => {
  it("lists registered kinds and reports their status", async () => {
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
      kind: "claude",
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
