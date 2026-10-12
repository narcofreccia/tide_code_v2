import { afterEach, describe, expect, it, vi } from "vitest";

type Listener = (status: string) => void;

const created: { url: string; auth: unknown; listeners: Listener[]; closed: boolean; calls: string[] }[] = [];

vi.mock("@tide/client", () => ({
  TideConnection: class {
    rec: (typeof created)[number];
    constructor(options: { url: string; auth: unknown }) {
      this.rec = { url: options.url, auth: options.auth, listeners: [], closed: false, calls: [] };
      created.push(this.rec);
    }
    on(_event: string, listener: Listener) {
      this.rec.listeners.push(listener);
    }
    call(method: string) {
      this.rec.calls.push(method);
      if (method === "settings.get") {
        return Promise.resolve({
          providerDefaults: { pi: { model: "m" } },
          worktreeByDefault: false,
          decisions: { enabled: false, hasKey: false },
        });
      }
      if (method === "providers.list") return Promise.resolve([]);
      return Promise.resolve({ environmentId: "env" });
    }
    stream() {
      return { cancel: () => undefined, done: Promise.resolve() };
    }
    connect() {
      return Promise.resolve();
    }
    close() {
      this.rec.closed = true;
    }
  },
  createModelStore: () => ({
    getState: () => ({ model: {}, status: "connecting", lastError: null }),
    subscribe: () => () => undefined,
    dispatch: () => Promise.resolve({ seq: 0, events: [] }),
    dispose: () => undefined,
  }),
}));

const { connectTo, startClient } = await import("./bootstrap.ts");
const { useServerSettings, resetServerSettings } = await import("../state/serverSettings.ts");

afterEach(() => {
  created.length = 0;
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  resetServerSettings();
});

describe("startClient", () => {
  it("reads the server settings each time the socket opens", async () => {
    const stop = startClient();
    const conn = created[0]!;
    for (const listener of conn.listeners) listener("open");
    await vi.waitFor(() => expect(useServerSettings.getState().loaded).toBe(true));
    expect(conn.calls).toContain("settings.get");
    expect(useServerSettings.getState().settings.worktreeByDefault).toBe(false);
    stop();
  });
});

describe("connectTo", () => {
  it("stores the server and token, drops the query hand-off and reconnects in place", () => {
    window.history.replaceState(null, "", "/?server=ws%3A%2F%2Fold%3A1%2Fws#/mission");
    startClient();
    expect(created[0]!.url).toBe("ws://old:1/ws");

    connectTo("ws://other:3777/ws", "tok-2");

    expect(window.localStorage.getItem("tide.serverUrl")).toBe("ws://other:3777/ws");
    expect(window.localStorage.getItem("tide.devToken")).toBe("tok-2");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#/mission");
    expect(created[0]!.closed).toBe(true);
    expect(created[1]!.url).toBe("ws://other:3777/ws");
    expect(created[1]!.closed).toBe(false);
  });
});
