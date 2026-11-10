import { describe, expect, it } from "vitest";
import { createHostPolicy, hostnameOf, isPrivateIp, mdnsHostName, parseAllowedHosts, relayOriginOf, trustedOrigin, type OriginContext } from "./hostOrigin.ts";

const hosts = createHostPolicy({ environmentId: "env-AbC123xyz", allowedHosts: parseAllowedHosts("tide.example.com, Box.Tail1234.ts.net:3777"), hostname: () => "Studio-Mac.local" });

describe("Host policy (DNS-rebinding defence)", () => {
  it.each([
    ["127.0.0.1:3777", true],
    ["localhost:3777", true],
    ["LOCALHOST", true],
    ["tauri.localhost", true],
    ["[::1]:3777", true],
    ["192.168.1.10:3777", true],
    ["203.0.113.5:3777", true], // any IP literal: rebinding needs a name
    ["[fe80::1]:3777", true],
    ["studio-mac.local:3777", true],
    ["studio-mac:3777", true],
    ["studio-mac.local.:3777", true],
    [`${mdnsHostName("env-AbC123xyz")}:3777`, true],
    ["tide.example.com", true],
    ["box.tail1234.ts.net:3777", true],
    [undefined, true],
    ["", true],
    ["evil.example", false],
    ["evil.example:3777", false],
    ["studio-mac.evil.example", false],
    ["studio-mac.tail9999.ts.net:3777", true], // this machine's own MagicDNS name
    ["other-mac.tail9999.ts.net", false],
    ["localhost.evil.example", false],
    ["other-mac.local", false],
  ])("Host %s → %s", (host, ok) => {
    expect(hosts.allowsHost(host)).toBe(ok);
  });

  it("names the mDNS host like the responder and parses host headers", () => {
    expect(mdnsHostName("env-AbC123xyz")).toBe("tide-123xyz.local");
    expect(hostnameOf("[::1]:80")).toBe("::1");
    expect(hostnameOf("Box.Local.:80")).toBe("box.local");
    expect(parseAllowedHosts(" a.example , ,B:1 ")).toEqual(["a.example", "b"]);
  });

  it("TIDE_ALLOWED_HOSTS=* turns the check off", () => {
    const open = createHostPolicy({ environmentId: "e", allowedHosts: parseAllowedHosts("*") });
    expect(open.allowsHost("anything.example")).toBe(true);
  });
});

describe("Origin rule for unauthenticated endpoints", () => {
  const ctx: OriginContext = { host: "192.168.1.10:3777", hosts, corsOrigins: ["http://localhost:5173"], relayOrigin: "https://relay.example" };
  it.each([
    [undefined, true, "curl / CLI / webhook senders / tide-mcp"],
    ["http://localhost:5173", true, "the Vite dev client"],
    ["http://127.0.0.1:5173", true, "loopback dev client"],
    ["tauri://localhost", true, "Tauri (macOS/Linux)"],
    ["http://tauri.localhost", true, "Tauri (Windows)"],
    ["https://tauri.localhost", true, "Tauri (Windows, https)"],
    ["http://192.168.1.20:3777", true, "another machine's tide-server page"],
    ["http://10.0.0.4:5173", true, "another machine's dev server"],
    ["http://100.101.102.103:3777", true, "Tailscale address"],
    ["http://[fd7a:115c:a1e0::1]:3777", true, "Tailscale IPv6 ULA"],
    ["http://other-mac.local:3777", true, "mDNS name"],
    ["http://nas:3777", true, "single-label LAN name"],
    ["http://192.168.1.10:3777", true, "this server's own page"],
    ["https://box.tail1234.ts.net", true, "TIDE_ALLOWED_HOSTS"],
    ["https://relay.example", true, "the web client through the relay"],
    ["https://evil.example", false, "public page"],
    ["http://203.0.113.5", false, "public IP page"],
    ["https://relay.example.evil.example", false, "lookalike"],
    ["null", false, "sandboxed iframe"],
    ["not a url", false, "garbage"],
  ])("Origin %s → %s (%s)", (origin, ok, _why) => {
    expect(trustedOrigin(origin, ctx)).toBe(ok);
  });

  it("an IP-literal page is trusted when it is this server's own Host", () => {
    expect(trustedOrigin("http://203.0.113.5:3777", { ...ctx, host: "203.0.113.5:3777" })).toBe(true);
  });

  it("classifies private addresses and derives the relay origin", () => {
    expect(["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.1.1", "100.64.0.1", "::ffff:192.168.1.1", "fe80::1", "fd00::1", "::1"].every(isPrivateIp)).toBe(true);
    expect(["8.8.8.8", "172.32.0.1", "100.128.0.1", "2001:db8::1"].some(isPrivateIp)).toBe(false);
    expect(relayOriginOf("wss://relay.example/")).toBe("https://relay.example");
    expect(relayOriginOf("https://relay.example:8443/c/env")).toBe("https://relay.example:8443");
    expect(relayOriginOf(undefined)).toBeUndefined();
  });
});
