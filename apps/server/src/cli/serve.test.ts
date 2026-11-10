import { describe, expect, it } from "vitest";
import { serveBanner } from "./serve.ts";

describe("serveBanner (R17 discovery)", () => {
  it("says the server is advertised on the LAN only when the responder is up", () => {
    const base = { environmentId: "e", name: "n", version: "v", host: "0.0.0.0", port: 3777, lanUrls: ["http://192.168.1.4:3777"], providers: [] };
    expect(serveBanner({ ...base, advertised: true })).toContain("advertised on the LAN as _tide._tcp");
    expect(serveBanner({ ...base, advertised: false })).not.toContain("_tide._tcp");
    expect(serveBanner(base)).not.toContain("_tide._tcp");
  });

  it("names wss on this machine and says TLS is on when the server has a certificate (R19)", () => {
    const base = { environmentId: "e", name: "n", version: "v", host: "0.0.0.0", port: 3777, lanUrls: ["https://192.168.1.4:3777"], providers: [] };
    const text = serveBanner({ ...base, tls: true });
    expect(text).toContain("wss://127.0.0.1:3777/ws on this machine");
    expect(text).toContain("TLS: on (HTTPS and WSS)");
    expect(text).toContain("reachable at https://192.168.1.4:3777");
    expect(serveBanner(base)).toContain("ws://127.0.0.1:3777/ws on this machine");
    expect(serveBanner(base)).not.toContain("TLS");
  });
});
