import { tmpdir } from "node:os";
import type { DriverEnv, NormalizedEvent, OpenSessionOptions } from "@tide/contracts";
import { createPiInstance } from "../src/index.ts";
import type { PiConfig } from "../src/types.ts";
import { baseScript, fakePi, type FakePi, type Script } from "./fake-pi.ts";

export const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };

export const options: OpenSessionOptions = {
  threadId: "t1",
  cwd: "/tmp/tide-pi-test",
  mode: "approval-required",
  interaction: "default",
  mcpServers: [],
};

/** Opens a session over a scripted fake pi; the driver's own commands go through `baseScript`. */
export async function open(script: Script, overrides: Partial<OpenSessionOptions> = {}, base: Script = baseScript()) {
  let pi!: FakePi;
  const instance = createPiInstance({} as PiConfig, env, {
    bridgePath: "/tmp/tide-bridge.js",
    probe: async () => "1.1.0",
    spawn: () => {
      pi = fakePi((command, self) => {
        base(command, self);
        script(command, self);
      });
      return pi;
    },
    fetch: async () => ({ ok: false, json: async () => undefined }),
  });
  const session = await instance.openSession({ ...options, ...overrides });
  return { session, instance, pi: () => pi };
}

export async function collect(stream: AsyncIterable<NormalizedEvent>): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** Lets queued stream/microtask work run; deterministic (no timers). */
export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
