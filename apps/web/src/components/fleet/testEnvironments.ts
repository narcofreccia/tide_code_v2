import { vi } from "vitest";
import { create } from "zustand";
import type { KnownEnvironment, ServerInfo } from "@tide/contracts";
import type { EnvStatus, EnvironmentsState } from "../../state/environments.ts";

/**
 * Test double for `state/environments.ts`: a real zustand store plus spies for the actions.
 * Use as `vi.mock("…/state/environments.ts", async () => (await import("…/testEnvironments.ts")).fakeEnvironmentsModule())`.
 */
export function fakeEnvironmentsModule() {
  const useEnvironments = create<EnvironmentsState>(() => ({ environments: [], statuses: {}, primaryId: undefined }));
  const projectEnvs: Record<string, string> = {};
  const threadEnvs: Record<string, string> = {};
  return {
    useEnvironments,
    projectEnvs,
    threadEnvs,
    addEnvironment: vi.fn(async (_input: unknown) => "env-new"),
    pairWithCode: vi.fn(async (_url: string, _code: string) => "env-new"),
    removeEnvironment: vi.fn((_id: string) => undefined),
    setPrimaryEnvironment: vi.fn((_id: string) => undefined),
    updateEnvironment: vi.fn((_id: string, _patch: unknown) => undefined),
    probeEnvironments: vi.fn(async () => undefined),
    envOfProject: (projectId: string): string | undefined => projectEnvs[projectId],
    envOfThread: (threadId: string): string | undefined => threadEnvs[threadId],
    environmentName: (id: string | undefined): string => {
      if (id === undefined) return "this machine";
      const state = useEnvironments.getState();
      return state.environments.find((e) => e.id === id)?.name ?? state.statuses[id]?.info?.name ?? id;
    },
  };
}

export function makeInfo(id: string, name: string, patch: Partial<ServerInfo> = {}): ServerInfo {
  return {
    environmentId: id,
    name,
    version: "0.9.0",
    startedAt: 1,
    host: { hostname: `${name}.local`, os: "darwin", arch: "arm64", cpus: 10, cpuLoad: 0.25, memTotal: 32 * 1024 ** 3, memFree: 8 * 1024 ** 3, busyThreads: 2 },
    harnesses: [
      { kind: "claude", version: "2.1.0", installed: true },
      { kind: "codex", installed: false },
    ],
    ...patch,
  };
}

export function makeEnv(id: string, name: string, url: string, kind: KnownEnvironment["routes"][number]["kind"] = "lan"): KnownEnvironment {
  return { id, name, routes: [{ kind, url, priority: 0 }], addedAt: 1 };
}

/** laptop (primary, local) + box (LAN, connected) + nas (unauthorized). */
export function twoMachines(): EnvironmentsState {
  const laptop = makeEnv("env-a", "laptop", "ws://127.0.0.1:3777/ws", "local");
  const box = makeEnv("env-b", "box", "ws://192.168.1.20:3777/ws");
  const nas = makeEnv("env-c", "nas", "ws://192.168.1.30:3777/ws");
  const statuses: Record<string, EnvStatus> = {
    "env-a": { connection: "connected", route: { kind: "local", url: "ws://127.0.0.1:3777/ws", priority: 0 }, info: makeInfo("env-a", "laptop") },
    "env-b": { connection: "connected", route: { kind: "lan", url: "ws://192.168.1.20:3777/ws", priority: 0 }, info: makeInfo("env-b", "box") },
    "env-c": { connection: "unauthorized", error: "401 token refused" },
  };
  return { environments: [laptop, box, nas], statuses, primaryId: "env-a" };
}
