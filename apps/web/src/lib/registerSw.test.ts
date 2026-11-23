import { afterEach, describe, expect, it, vi } from "vitest";
import { useToasts } from "../state/toast.ts";
import { registerServiceWorker, type SwEnv } from "./registerSw.ts";

function fakeEnv(href: string, opts: { worker?: boolean; caches?: boolean; controller?: boolean } = {}) {
  const unregister = vi.fn(() => Promise.resolve(true));
  const listeners: Array<() => void> = [];
  const serviceWorker = {
    controller: opts.controller ? {} : null,
    register: vi.fn(() => Promise.resolve({})),
    getRegistrations: vi.fn(() => Promise.resolve([{ unregister }, { unregister }])),
    addEventListener: vi.fn((_type: string, fn: () => void) => listeners.push(fn)),
  };
  const store = new Set(["tide-shell-b1", "tide-shell-b2", "other-app"]);
  const cacheStorage = {
    keys: vi.fn(() => Promise.resolve([...store])),
    delete: vi.fn((name: string) => Promise.resolve(store.delete(name))),
  };
  const loads: Array<() => void> = [];
  const env: SwEnv = {
    location: { protocol: new URL(href).protocol, href },
    serviceWorker: opts.worker === false ? undefined : (serviceWorker as unknown as ServiceWorkerContainer),
    caches: opts.caches === false ? undefined : (cacheStorage as unknown as CacheStorage),
    onLoad: (run) => loads.push(run),
    reload: vi.fn(),
  };
  return { env, serviceWorker, unregister, cacheStorage, store, loads, listeners };
}

afterEach(() => useToasts.setState({ toasts: [] }));

describe("registerServiceWorker", () => {
  it.each(["tauri://localhost/", "http://tauri.localhost/#/mission", "https://tauri.localhost/"])(
    "never registers inside the desktop shell (%s) and retires what is left",
    async (href) => {
      const f = fakeEnv(href);
      await registerServiceWorker(f.env);
      f.loads.forEach((run) => run());
      expect(f.serviceWorker.register).not.toHaveBeenCalled();
      expect(f.unregister).toHaveBeenCalledTimes(2);
      expect(f.cacheStorage.delete.mock.calls.map(([name]) => name).sort()).toEqual(["tide-shell-b1", "tide-shell-b2"]);
      expect([...f.store]).toEqual(["other-app"]);
    },
  );

  it("tolerates a shell without workers or caches, and failures while retiring", async () => {
    await expect(registerServiceWorker(fakeEnv("http://tauri.localhost/", { worker: false, caches: false }).env)).resolves.toBeUndefined();
    const f = fakeEnv("tauri://localhost/");
    f.serviceWorker.getRegistrations.mockImplementation(() => Promise.reject(new Error("denied")));
    f.cacheStorage.keys.mockImplementation(() => Promise.reject(new Error("denied")));
    await expect(registerServiceWorker(f.env)).resolves.toBeUndefined();
  });

  it("registers the module worker on load on an ordinary origin", async () => {
    const f = fakeEnv("http://192.168.1.20:3777/");
    await registerServiceWorker(f.env);
    expect(f.serviceWorker.register).not.toHaveBeenCalled();
    f.loads.forEach((run) => run());
    expect(f.serviceWorker.register).toHaveBeenCalledWith("/sw.js", { type: "module" });
    expect(f.serviceWorker.getRegistrations).not.toHaveBeenCalled();
    expect(f.cacheStorage.keys).not.toHaveBeenCalled();
  });

  it("offers a reload when a new worker takes over an already controlled page", async () => {
    const f = fakeEnv("https://tide.example.ts.net/", { controller: true });
    await registerServiceWorker(f.env);
    f.listeners.forEach((fn) => fn());
    const toast = useToasts.getState().toasts.at(-1);
    expect(toast?.text).toBe("New version available");
    toast?.action?.onClick();
    expect(f.env.reload).toHaveBeenCalled();
  });

  it("does nothing without service worker support", async () => {
    const f = fakeEnv("http://10.0.0.5:3777/", { worker: false });
    await expect(registerServiceWorker(f.env)).resolves.toBeUndefined();
    expect(f.loads).toHaveLength(0);
  });
});
