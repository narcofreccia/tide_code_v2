import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "@tide/client";
import { connectTo, startClient } from "./bootstrap.ts";
import { flushMicrotasks, installFakeConnections } from "../state/fakeEnvConnection.ts";
import { resetEnvManager, setEnvFetch } from "../state/envManager.ts";
import { ENVIRONMENTS_KEY, loadEnvironments } from "../state/envPersist.ts";
import { useEnvironments } from "../state/environments.ts";
import { resetServerSettings, useServerSettings } from "../state/serverSettings.ts";
import { resetProviders } from "../state/providers.ts";
import { defaultUserSettings } from "../state/serverSettings.ts";

let fakes: ReturnType<typeof installFakeConnections>;

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  resetEnvManager();
  resetProviders();
  resetServerSettings();
  fakes = installFakeConnections();
});
afterEach(() => {
  resetEnvManager();
  window.history.replaceState(null, "", "/");
});

describe("startClient", () => {
  it("turns the legacy ?server= / ?token= hand-off into the local environment", () => {
    window.history.replaceState(null, "", "/?server=ws%3A%2F%2F127.0.0.1%3A4100%2Fws&token=tk#/mission");
    startClient();
    const { environments, primaryId } = useEnvironments.getState();
    expect(environments).toHaveLength(1);
    expect(environments[0]).toMatchObject({ id: "local", token: "tk", routes: [{ kind: "local", url: "ws://127.0.0.1:4100/ws", priority: 0 }] });
    expect(primaryId).toBe("local");
    expect(fakes.byId("local").opts).toMatchObject({ verifyId: false, token: "tk", authMode: "token" });
    // the token does not linger in the address bar
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#/mission");
    expect(loadEnvironments()?.environments[0]?.routes[0]?.url).toBe("ws://127.0.0.1:4100/ws");
  });

  it("adopts the local server's real id once it answers", () => {
    startClient();
    fakes.byId("local").emit({ state: "connecting", environmentId: "env-L" });
    expect(useEnvironments.getState().environments.map((e) => e.id)).toEqual(["env-L"]);
    expect(useEnvironments.getState().primaryId).toBe("env-L");
    expect(loadEnvironments()?.primaryId).toBe("env-L");
  });

  it("never lets the launch URL override the user's list or primary", () => {
    window.localStorage.setItem(ENVIRONMENTS_KEY, JSON.stringify({
      environments: [
        { id: "env-L", name: "mac", routes: [{ kind: "local", url: "ws://127.0.0.1:3777/ws", priority: 0 }], token: "old", addedAt: 1 },
        { id: "env-R", name: "studio", routes: [{ kind: "lan", url: "ws://10.0.0.7:3777/ws", priority: 10 }], token: "r", addedAt: 2 },
      ],
      primaryId: "env-R",
      ownership: { projects: {}, threads: {} },
    }));
    // the desktop supervisor passes its sidecar on every launch
    window.history.replaceState(null, "", "/?server=ws%3A%2F%2F127.0.0.1%3A5000%2Fws&token=new");
    startClient();
    const { environments, primaryId } = useEnvironments.getState();
    expect(primaryId).toBe("env-R");
    expect(environments.find((e) => e.id === "env-R")).toMatchObject({ token: "r", routes: [{ url: "ws://10.0.0.7:3777/ws" }] });
    expect(environments.find((e) => e.id === "env-L")).toMatchObject({ token: "new", routes: [{ kind: "local", url: "ws://127.0.0.1:5000/ws" }] });
    expect(fakes.conns.map((c) => c.opts.id).sort()).toEqual(["env-L", "env-R"]);
  });

  it("reads the primary's settings each time it connects", async () => {
    startClient();
    const local = fakes.byId("local");
    local.handlers["settings.get"] = () => ({ ...defaultUserSettings(), worktreeByDefault: false });
    local.emit({ state: "connected", environmentId: "env-L" });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(useServerSettings.getState().loaded).toBe(true);
    expect(useServerSettings.getState().settings.worktreeByDefault).toBe(false);
  });
});

describe("connectTo", () => {
  it("adds the server as an environment and makes it the primary, keeping the local one", async () => {
    window.history.replaceState(null, "", "/?server=ws%3A%2F%2Fold%3A1%2Fws#/mission");
    startClient();
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ environmentId: "env-O", name: "other", version: "1", protocol: 1 }) });
    setEnvFetch(fetchImpl);

    const id = await connectTo("ws://10.1.1.1:3777/ws", "tok-2");

    expect(id).toBe("env-O");
    expect(useEnvironments.getState().primaryId).toBe("env-O");
    expect(useEnvironments.getState().environments.map((e) => e.id)).toEqual(["local", "env-O"]);
    expect(fakes.byId("env-O").opts).toMatchObject({ token: "tok-2", routes: [{ kind: "lan", url: "ws://10.1.1.1:3777/ws" }] });
    expect(fakes.byId("local").stopped).toBe(false);
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#/mission");
  });
});
