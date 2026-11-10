import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UserSettings } from "@tide/contracts";
import { makeEnv } from "../components/fleet/testEnvironments.ts";
import { mockRpc, resetUi } from "../testHarness.ts";
import { useEnvironments } from "./envStore.ts";
import { useToasts } from "./toast.ts";
import {
  defaultUserSettings,
  loadServerSettings,
  patchServerSettings,
  resetServerSettings,
  retryServerSettings,
  selectedSettings,
  selectSettingsEnv,
  useServerSettings,
} from "./serverSettings.ts";

const A = defaultUserSettings();
const B: UserSettings = { ...defaultUserSettings(), followUpMode: "queue", environment: { name: "studio" } };

beforeEach(() => {
  useEnvironments.setState({
    environments: [makeEnv("a", "laptop", "http://a"), makeEnv("b", "studio", "http://b")],
    statuses: { a: { connection: "connected" }, b: { connection: "connected" } },
    primaryId: "a",
  });
});

afterEach(() => {
  resetServerSettings();
  useEnvironments.setState({ environments: [], statuses: {}, primaryId: undefined });
  resetUi();
});

const answers = (rpc: ReturnType<typeof mockRpc>) => rpc.mock.calls;

describe("settings per environment", () => {
  it("keeps every environment's answer; the primary mirror ignores the others", async () => {
    mockRpc({ "settings.get": (_p: never) => A });
    await loadServerSettings("a");
    mockRpc({ "settings.get": () => B });
    await loadServerSettings("b");
    expect(useServerSettings.getState().settings.followUpMode).toBe("steer");
    expect(useServerSettings.getState().byEnv["b"]?.settings.followUpMode).toBe("queue");
  });

  it("sends a patch to the selected environment only", async () => {
    mockRpc({ "settings.get": () => A });
    await loadServerSettings("a");
    mockRpc({ "settings.get": () => B });
    await loadServerSettings("b");
    selectSettingsEnv("b");
    expect(selectedSettings().environment.name).toBe("studio");
    const rpc = mockRpc({ "settings.set": () => ({ ...B, followUpMode: "steer" as const }) });
    await patchServerSettings({ followUpMode: "steer" });
    expect(answers(rpc)).toEqual([["settings.set", { patch: { followUpMode: "steer" } }, { envId: "b" }]]);
    expect(useServerSettings.getState().byEnv["b"]?.settings.followUpMode).toBe("steer");
    expect(useServerSettings.getState().settings.followUpMode).toBe("steer");
    expect(useServerSettings.getState().settings).toBe(A);
  });

  it("an explicit envId beats the selection, and no selection means the primary", async () => {
    mockRpc({ "settings.get": () => B });
    await loadServerSettings("b");
    useServerSettings.setState({ loaded: true });
    selectSettingsEnv("b");
    const rpc = mockRpc({ "settings.set": () => A });
    await patchServerSettings({ worktreeByDefault: false }, "a");
    selectSettingsEnv(undefined);
    await patchServerSettings({ worktreeByDefault: false });
    expect(answers(rpc)).toEqual([
      ["settings.set", { patch: { worktreeByDefault: false } }],
      ["settings.set", { patch: { worktreeByDefault: false } }],
    ]);
  });

  it("refuses to patch an environment whose settings have not loaded, and keeps a failed load for Retry", async () => {
    selectSettingsEnv("b");
    const rpc = mockRpc({
      "settings.get": () => {
        throw new Error("offline");
      },
    });
    await expect(loadServerSettings("b")).rejects.toThrow("offline");
    expect(useServerSettings.getState().byEnv["b"]).toMatchObject({ loaded: false, error: "offline" });
    await patchServerSettings({ teams: [] });
    expect(answers(rpc).filter(([method]) => method === "settings.set")).toEqual([]);
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["Settings are still loading"]);
    mockRpc({ "settings.get": () => B });
    await retryServerSettings();
    expect(useServerSettings.getState().byEnv["b"]).toEqual({ settings: B, loaded: true });
  });

  it("switching the selection keeps both entries; changing the primary swaps the mirror", async () => {
    mockRpc({ "settings.get": () => A });
    await loadServerSettings("a");
    mockRpc({ "settings.get": () => B });
    await loadServerSettings("b");
    selectSettingsEnv("b");
    selectSettingsEnv(undefined);
    expect(selectedSettings().followUpMode).toBe("steer");
    useEnvironments.setState({ primaryId: "b" });
    expect(useServerSettings.getState().settings.followUpMode).toBe("queue");
    expect(useServerSettings.getState().byEnv["a"]?.settings.followUpMode).toBe("steer");
  });

  it("drops the entry and the selection of an environment that leaves", async () => {
    mockRpc({ "settings.get": () => B });
    await loadServerSettings("b");
    selectSettingsEnv("b");
    useEnvironments.setState({ statuses: { a: { connection: "connected" }, b: { connection: "offline" } } });
    expect(useServerSettings.getState().byEnv["b"]).toBeUndefined();
    expect(useServerSettings.getState().selectedId).toBeUndefined();
  });
});
