import { describe, expect, it } from "vitest";
import { httpOriginFor } from "./bootstrap.ts";

describe("httpOriginFor", () => {
  it("derives the http origin of a ws url", () => {
    expect(httpOriginFor("ws://127.0.0.1:3777/ws")).toBe("http://127.0.0.1:3777");
  });

  it("keeps tls when the socket is secure", () => {
    expect(httpOriginFor("wss://tide.example.com/ws")).toBe("https://tide.example.com");
  });

  it("keeps a non-default port", () => {
    expect(httpOriginFor("wss://host.local:8443/ws")).toBe("https://host.local:8443");
  });
});
