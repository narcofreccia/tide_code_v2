import { describe, expect, it } from "vitest";
import type { ProviderDriver, ProviderInstance, ProviderStatus } from "@tide/contracts";
import { createApp } from "./app.ts";
import { baseConfig } from "./vcs/testing/vcsHarness.ts";
import { createFakeDriver } from "./provider/testing/fakeDriver.ts";

// R23: the harnesses' status (and model lists) is read once at boot, so the first session's
// delegate hint has them before any client called providers.list.

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** The fake claude driver with its status() held at a gate, recording what happens when. */
function gatedDriver() {
  const { driver, control } = createFakeDriver("claude");
  const gate = deferred<void>();
  const called = deferred<void>();
  const trace: string[] = [];
  let calls = 0;
  const gated: ProviderDriver<Record<string, unknown>> = {
    ...driver,
    async create(config, env) {
      const inner = await driver.create(config, env);
      const instance: ProviderInstance = {
        ...inner,
        async status(): Promise<ProviderStatus> {
          calls++;
          called.resolve();
          await gate.promise;
          trace.push("status answered");
          return control.statusResult;
        },
        async dispose() {
          trace.push("disposed");
          await inner.dispose();
        },
      };
      return instance;
    },
  };
  return { driver: gated, gate, called, trace, calls: () => calls };
}

describe("createApp — harness status at boot", () => {
  it("reads every harness's status once after boot, with no client asking, and logs it", async () => {
    const d = gatedDriver();
    const logs: string[] = [];
    const app = await createApp({ config: baseConfig("/tmp/tide-warmup-test"), listen: false, log: (msg) => void logs.push(msg), registerDrivers: (r) => r.register(d.driver) });
    await d.called.promise;
    expect(d.calls()).toBe(1);
    expect(app.registry.cachedModels("claude")).toBeUndefined();
    d.gate.resolve();
    await app.close();
    // bundled kinds without a registered driver are reported too (the build lacks them)
    expect(logs.find((l) => l.startsWith("[provider] status at boot"))).toMatch(/^\[provider\] status at boot: claude 1 model, codex not installed,/);
    expect(d.calls()).toBe(1);
  });

  it("lets close() settle a read still in flight before the instances are disposed", async () => {
    const d = gatedDriver();
    const app = await createApp({
      config: baseConfig("/tmp/tide-warmup-test"),
      listen: false,
      log: (msg) => void (msg.startsWith("[provider] status at boot") && d.trace.push("boot logged")),
      registerDrivers: (r) => r.register(d.driver),
    });
    await d.called.promise;
    const closing = app.close();
    // released on a later macrotask: a close() that did not wait for the read would have disposed by then
    setImmediate(() => d.gate.resolve());
    await closing;
    expect(d.trace).toEqual(["status answered", "boot logged", "disposed"]);
  });

  it("is off with warmProviderStatus: false", async () => {
    const d = gatedDriver();
    const app = await createApp({ config: baseConfig("/tmp/tide-warmup-test"), listen: false, log: () => undefined, warmProviderStatus: false, registerDrivers: (r) => r.register(d.driver) });
    await app.close();
    expect(d.calls()).toBe(0);
  });
});
