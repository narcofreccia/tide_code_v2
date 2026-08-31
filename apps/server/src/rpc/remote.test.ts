import { describe, expect, it } from "vitest";
import type { NetworkInterfaceInfo } from "node:os";
import { buildRemoteInfo, isLoopbackHost, lanIps, pairPage, type Interfaces } from "./remote.ts";

const v4 = (address: string, internal: boolean): NetworkInterfaceInfo =>
  ({ address, netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal, cidr: `${address}/24` }) as NetworkInterfaceInfo;

const v6 = (address: string): NetworkInterfaceInfo =>
  ({ address, netmask: "ffff::", family: "IPv6", mac: "00:00:00:00:00:00", internal: false, cidr: `${address}/64`, scopeid: 0 }) as NetworkInterfaceInfo;

const INTERFACES: Interfaces = {
  lo0: [v4("127.0.0.1", true)],
  en0: [v4("192.168.1.42", false), v6("fe80::1")],
  en1: [v4("10.0.0.7", false)],
  utun0: [],
};

describe("isLoopbackHost", () => {
  it("knows the local-only bind hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.42")).toBe(false);
  });
});

describe("lanIps", () => {
  it("keeps routable IPv4 addresses only, in interface order", () => {
    expect(lanIps(INTERFACES)).toEqual(["192.168.1.42", "10.0.0.7"]);
  });

  it("is empty on a host with nothing but loopback", () => {
    expect(lanIps({ lo0: [v4("127.0.0.1", true)] })).toEqual([]);
  });
});

describe("buildRemoteInfo", () => {
  it("advertises no LAN URLs on a loopback bind and pairs over 127.0.0.1", () => {
    const remote = buildRemoteInfo({ host: "127.0.0.1", port: 3777, token: "tok", includePairing: true, interfaces: INTERFACES });
    expect(remote).toEqual({
      host: "127.0.0.1",
      port: 3777,
      lanUrls: [],
      pairingUrl: "http://127.0.0.1:3777/pair#token=tok",
    });
  });

  it("lists every routable address when bound to 0.0.0.0", () => {
    const remote = buildRemoteInfo({ host: "0.0.0.0", port: 8080, token: "tok", includePairing: true, interfaces: INTERFACES });
    expect(remote).toEqual({
      host: "0.0.0.0",
      port: 8080,
      lanUrls: ["ws://192.168.1.42:8080/ws", "ws://10.0.0.7:8080/ws"],
      pairingUrl: "http://192.168.1.42:8080/pair#token=tok",
    });
  });

  it("never leaks the pairing URL when pairing is not requested", () => {
    const remote = buildRemoteInfo({ host: "0.0.0.0", port: 1, token: "secret", includePairing: false, interfaces: INTERFACES });
    expect(remote.pairingUrl).toBeUndefined();
    expect(JSON.stringify(remote)).not.toContain("secret");
  });
});

describe("pairPage", () => {
  it("shows the LAN websocket URL and never embeds the token", () => {
    const html = pairPage({ lanUrls: ["ws://192.168.1.42:8080/ws"], port: 8080 });
    expect(html).toContain("ws://192.168.1.42:8080/ws");
    expect(html).toContain("location.hash");
    expect(html).not.toContain("token=");
  });

  it("falls back to loopback when nothing is on the LAN", () => {
    expect(pairPage({ lanUrls: [], port: 3777 })).toContain("ws://127.0.0.1:3777/ws");
  });
});
