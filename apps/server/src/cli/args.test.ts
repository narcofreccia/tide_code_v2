import { describe, expect, it } from "vitest";
import { rootPackageVersion, VERSION } from "../version.ts";
import { CliError, parseCli } from "./args.ts";
import { pairLink, pairText } from "./pair.ts";
import { serveBanner } from "./serve.ts";

describe("parseCli", () => {
  it("keeps the legacy forms: no args and bare flags serve on loopback", () => {
    expect(parseCli([])).toEqual({ cmd: "serve", args: [], legacy: true });
    expect(parseCli(["--port", "4000", "--dev"])).toEqual({ cmd: "serve", args: ["--port", "4000", "--dev"], legacy: true });
    expect(parseCli(["--mcp"])).toEqual({ cmd: "mcp" });
  });

  it("parses serve with its flags", () => {
    const argv = ["serve", "--host", "0.0.0.0", "--port", "3800", "--data", "/d", "--name", "studio", "--web", "/w", "--log", "/l"];
    expect(parseCli(argv)).toEqual({ cmd: "serve", args: argv.slice(1), legacy: false });
    expect(() => parseCli(["serve", "--bogus"])).toThrow(CliError);
    expect(() => parseCli(["serve", "stray"])).toThrow(/unexpected argument stray/);
    expect(() => parseCli(["serve", "--name"])).toThrow(/missing value/);
  });

  it("parses pair, doctor, service and version", () => {
    expect(parseCli(["pair"])).toEqual({ cmd: "pair", qr: true });
    expect(parseCli(["pair", "--port", "3800", "--host", "10.0.0.2", "--no-qr"])).toEqual({ cmd: "pair", port: 3800, host: "10.0.0.2", qr: false });
    expect(() => parseCli(["pair", "--port", "x"])).toThrow(/port number/);
    expect(parseCli(["doctor"])).toEqual({ cmd: "doctor" });
    expect(parseCli(["doctor", "--port", "4000"])).toEqual({ cmd: "doctor", port: 4000 });
    expect(parseCli(["service", "install", "--port", "3800", "--name", "box"])).toEqual({ cmd: "service", action: "install", serveArgs: ["--port", "3800", "--name", "box"] });
    expect(parseCli(["service", "status"])).toEqual({ cmd: "service", action: "status", serveArgs: [] });
    expect(() => parseCli(["service", "install", "--log", "/x"])).toThrow(CliError);
    expect(() => parseCli(["service", "restart"])).toThrow(CliError);
    expect(parseCli(["update"])).toEqual({ cmd: "update", check: false, yes: false });
    expect(parseCli(["update", "--check", "--yes"])).toEqual({ cmd: "update", check: true, yes: true });
    expect(() => parseCli(["update", "--force"])).toThrow(/unknown argument --force/);
    expect(parseCli(["--version"])).toEqual({ cmd: "version" });
    expect(parseCli(["help"])).toEqual({ cmd: "help" });
    expect(() => parseCli(["frobnicate"])).toThrow(/unknown command/);
  });
});

describe("version", () => {
  it("is the workspace root's version, never the server package's 0.0.0", () => {
    expect(rootPackageVersion()).toBeDefined();
    expect(VERSION).toBe(rootPackageVersion());
    expect(VERSION).not.toMatch(/^0\.0\.0/);
  });
});

describe("output", () => {
  it("serve banner lists URLs, the code, and the tide pair reminder", () => {
    const text = serveBanner({
      environmentId: "env1",
      name: "studio",
      version: "2.0.0",
      host: "0.0.0.0",
      port: 3777,
      lanUrls: ["http://192.168.1.4:3777"],
      providers: ["claude"],
      pairing: { code: "123456", expiresAt: Date.now() + 300_000 },
    });
    expect(text).toContain('"studio" (env env1)');
    expect(text).toContain("reachable at http://192.168.1.4:3777");
    expect(text).toContain("pairing code: 123456");
    expect(text).toContain("tide pair");
    expect(text).not.toContain("token:");
    expect(serveBanner({ environmentId: "e", name: "n", version: "v", host: "127.0.0.1", port: 1, lanUrls: [], providers: [] })).toContain("loopback only");
  });

  it("pair text carries the code, URLs and a fragment link", () => {
    expect(pairLink(["http://10.0.0.2:3777/"], "042042")).toBe("http://10.0.0.2:3777/#pair=042042");
    const text = pairText({ name: "box", code: "042042", expiresAt: 1_300_000, urls: ["http://10.0.0.2:3777"], now: 1_000_000, qr: "QR" });
    expect(text).toContain("code: 042042");
    expect(text).toContain("expires in 5 min");
    expect(text).toContain("http://10.0.0.2:3777/#pair=042042");
    expect(text.endsWith("QR")).toBe(true);
  });
});
