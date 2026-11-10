import { describe, expect, it } from "vitest";
import { offlineReason } from "../state/threadEnv.ts";
import { MIXED_CONTENT_REASON, mixedContentBlocked, mixedContentReason, routeSecurity } from "./routeSecurity.ts";

describe("routeSecurity (R19)", () => {
  it("wss and https are encrypted, relay routes included", () => {
    expect(routeSecurity("wss://box.tail1234.ts.net/ws")).toBe("encrypted");
    expect(routeSecurity("https://192.168.1.4:3777")).toBe("encrypted");
    expect(routeSecurity("wss://relay.example/c/env-1")).toBe("encrypted");
  });

  it("loopback stays on this computer", () => {
    for (const url of ["ws://127.0.0.1:3777/ws", "http://localhost:3777", "ws://[::1]:3777/ws", "ws://tauri.localhost/ws", "ws://127.0.0.2:1/ws"]) expect(routeSecurity(url)).toBe("local");
  });

  it("plain HTTP to anything else is plain, and so is a URL that does not parse", () => {
    expect(routeSecurity("ws://192.168.1.4:3777/ws")).toBe("plain");
    expect(routeSecurity("http://box.local:3777")).toBe("plain");
    expect(routeSecurity("ws://100.101.102.103:3777/ws")).toBe("plain");
    expect(routeSecurity("not a url")).toBe("plain");
  });
});

describe("mixed content (R19)", () => {
  it("an https page cannot open plain ws to another machine; loopback and http pages are fine", () => {
    expect(mixedContentBlocked("ws://192.168.1.4:3777/ws", "https:")).toBe(true);
    expect(mixedContentBlocked("ws://127.0.0.1:3777/ws", "https:")).toBe(false);
    expect(mixedContentBlocked("wss://box.ts.net/ws", "https:")).toBe(false);
    expect(mixedContentBlocked("ws://192.168.1.4:3777/ws", "http:")).toBe(false);
    expect(mixedContentBlocked("ws://192.168.1.4:3777/ws", "tauri:")).toBe(false);
  });

  it("names the cause only when every route is blocked", () => {
    expect(mixedContentReason([{ url: "ws://192.168.1.4:3777/ws" }, { url: "ws://10.0.0.2:3777/ws" }], "https:")).toBe(MIXED_CONTENT_REASON);
    expect(mixedContentReason([{ url: "ws://192.168.1.4:3777/ws" }, { url: "wss://relay.example/c/e" }], "https:")).toBeUndefined();
    expect(mixedContentReason([], "https:")).toBeUndefined();
  });

  it("the composer and card copy use it instead of the generic offline text", () => {
    expect(offlineReason({ online: false, primary: false, machine: "nas", mixedContent: true })).toBe(MIXED_CONTENT_REASON);
    expect(offlineReason({ online: false, primary: false, machine: "nas" })).toBe("nas is offline");
  });
});
