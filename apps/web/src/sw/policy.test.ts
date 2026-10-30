import { describe, expect, it } from "vitest";
import { cacheName, isStaleCache, strategyFor } from "./policy.ts";

const origin = "https://tide.example";
const at = (path: string, method = "GET", base = origin) => strategyFor(new URL(path, base), method, origin);

describe("service worker cache policy", () => {
  it("never touches the websocket, API or hook routes", () => {
    expect(at("/ws")).toBe("bypass");
    expect(at("/ws?ticket=1")).toBe("bypass");
    expect(at("/api/auth/ws-ticket")).toBe("bypass");
    expect(at("/hook/claude")).toBe("bypass");
  });
  it("leaves non-GET and cross-origin requests alone", () => {
    expect(at("/assets/a-1.js", "POST")).toBe("bypass");
    expect(at("/assets/a-1.js", "GET", "https://cdn.other")).toBe("bypass");
  });
  it("caches hashed build assets first", () => {
    expect(at("/assets/index-abc.js")).toBe("cache-first");
  });
  it("serves the shell network-first so a deploy is picked up", () => {
    expect(at("/")).toBe("network-first");
    expect(at("/manifest.webmanifest")).toBe("network-first");
    expect(at("/wsx")).toBe("network-first");
  });
  it("versions the cache and drops only older tide caches", () => {
    const cur = cacheName("b2");
    expect(cur).toBe("tide-shell-b2");
    expect(isStaleCache("tide-shell-b1", cur)).toBe(true);
    expect(isStaleCache(cur, cur)).toBe(false);
    expect(isStaleCache("other-app", cur)).toBe(false);
  });
});
