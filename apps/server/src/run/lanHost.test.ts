import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { lanHost } from "./lanHost.ts";

const addr = (address: string, family: "IPv4" | "IPv6", internal = false): NetworkInterfaceInfo =>
  ({ address, family, internal, netmask: "", mac: "", cidr: null, ...(family === "IPv6" ? { scopeid: 0 } : {}) }) as NetworkInterfaceInfo;

describe("lanHost", () => {
  it("prefers en0, then any non-internal IPv4, else localhost", () => {
    expect(lanHost({ lo0: [addr("127.0.0.1", "IPv4", true)], utun3: [addr("10.8.0.2", "IPv4")], en0: [addr("fe80::1", "IPv6"), addr("192.168.1.20", "IPv4")] })).toBe("192.168.1.20");
    expect(lanHost({ lo0: [addr("127.0.0.1", "IPv4", true)], wlan0: [addr("10.0.0.5", "IPv4")] })).toBe("10.0.0.5");
    expect(lanHost({ lo0: [addr("127.0.0.1", "IPv4", true)] })).toBe("localhost");
  });
});
