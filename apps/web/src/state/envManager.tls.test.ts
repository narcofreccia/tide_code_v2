import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvRoute } from "@tide/contracts";
import { MIXED_CONTENT_REASON } from "../lib/routeSecurity.ts";
import { toEnvStatus } from "./envManager.ts";

const lan: EnvRoute = { kind: "lan", url: "ws://192.168.1.4:3777/ws", priority: 10 };
const relay: EnvRoute = { kind: "relay", url: "wss://relay.example/c/e", priority: 50 };

afterEach(() => vi.unstubAllGlobals());

describe("toEnvStatus mixed content (R19)", () => {
  it("replaces the socket error when the page is https and every route is plain to another machine", () => {
    vi.stubGlobal("location", { protocol: "https:" });
    expect(toEnvStatus({ state: "offline", error: "ws://192.168.1.4:3777/ws: websocket error" } as Parameters<typeof toEnvStatus>[0], [lan]).error).toBe(MIXED_CONTENT_REASON);
    // a route that can work keeps the real error
    expect(toEnvStatus({ state: "offline", error: "boom" } as Parameters<typeof toEnvStatus>[0], [lan, relay]).error).toBe("boom");
  });

  it("keeps the socket error on an http page", () => {
    vi.stubGlobal("location", { protocol: "http:" });
    expect(toEnvStatus({ state: "offline", error: "boom" } as Parameters<typeof toEnvStatus>[0], [lan]).error).toBe("boom");
  });
});
