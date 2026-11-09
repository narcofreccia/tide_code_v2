import { describe, expect, it } from "vitest";
import { serveBanner } from "./serve.ts";

describe("serveBanner (R17 discovery)", () => {
  it("says the server is advertised on the LAN only when the responder is up", () => {
    const base = { environmentId: "e", name: "n", version: "v", host: "0.0.0.0", port: 3777, lanUrls: ["http://192.168.1.4:3777"], providers: [] };
    expect(serveBanner({ ...base, advertised: true })).toContain("advertised on the LAN as _tide._tcp");
    expect(serveBanner({ ...base, advertised: false })).not.toContain("_tide._tcp");
    expect(serveBanner(base)).not.toContain("_tide._tcp");
  });
});
