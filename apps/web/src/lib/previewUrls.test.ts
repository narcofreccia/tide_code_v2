import { describe, expect, it } from "vitest";
import type { EnvRoute, KnownEnvironment } from "@tide/contracts";
import type { EnvironmentsState } from "../state/environments.ts";
import { previewUrlFor, rehostLoopback } from "./previewUrls.ts";

const env = (id: string, routes: EnvRoute[]): KnownEnvironment => ({ id, name: id, routes, addedAt: 1 });
const route = (kind: EnvRoute["kind"], url: string, priority = 0): EnvRoute => ({ kind, url, priority });
const stateOf = (envs: KnownEnvironment[], connected?: Record<string, EnvRoute>): EnvironmentsState => ({
  environments: envs,
  statuses: Object.fromEntries(Object.entries(connected ?? {}).map(([id, r]) => [id, { connection: "connected" as const, route: r }])),
  primaryId: undefined,
});

describe("previewUrlFor", () => {
  it("keeps localhost for the local env, an unknown env and no env", () => {
    const state = stateOf([env("L", [route("local", "ws://127.0.0.1:3777/ws")])]);
    expect(previewUrlFor("L", 3000, state)).toBe("http://localhost:3000");
    expect(previewUrlFor("nope", 3000, state)).toBe("http://localhost:3000");
    expect(previewUrlFor(undefined, 3000, state)).toBe("http://localhost:3000");
  });

  it("uses the host of a LAN route", () => {
    const state = stateOf([env("R", [route("lan", "ws://192.168.1.20:3777/ws")])]);
    expect(previewUrlFor("R", 3000, state)).toBe("http://192.168.1.20:3000");
  });

  it("falls back to loopback for a relay-only env, and to the direct route when there is one", () => {
    const relay = route("relay", "wss://relay.example.com/e/R", 5);
    expect(previewUrlFor("R", 3000, stateOf([env("R", [relay])], { R: relay }))).toBe("http://localhost:3000");
    const lan = route("lan", "ws://10.0.0.7:3777/ws", 1);
    expect(previewUrlFor("R", 3000, stateOf([env("R", [relay, lan])], { R: relay }))).toBe("http://10.0.0.7:3000");
  });

  it("keeps IPv6 hosts bracketed", () => {
    const state = stateOf([env("R", [route("custom", "ws://[fd7a::1]:3777/ws")])]);
    expect(previewUrlFor("R", 3000, state)).toBe("http://[fd7a::1]:3000");
  });
});

describe("rehostLoopback", () => {
  const state = stateOf([env("R", [route("lan", "ws://192.168.1.20:3777/ws")])]);

  it("swaps loopback hosts for the env host, keeping port and path", () => {
    expect(rehostLoopback("http://127.0.0.1:5173/app?x=1", "R", state)).toBe("http://192.168.1.20:5173/app?x=1");
    expect(rehostLoopback("http://localhost:5173", "R", state)).toBe("http://192.168.1.20:5173/");
    expect(rehostLoopback("http://[::1]:5173/", "R", state)).toBe("http://192.168.1.20:5173/");
  });

  it("leaves other hosts and local envs alone", () => {
    expect(rehostLoopback("http://example.com:80/x", "R", state)).toBe("http://example.com:80/x");
    expect(rehostLoopback("http://127.0.0.1:5173/", undefined, state)).toBe("http://127.0.0.1:5173/");
  });
});
