import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchdPlist, runService, selfCommand, serviceSpec, systemdUnit, type Exec } from "./service.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "tide-svc-"));
  dirs.push(d);
  return d;
};

const base = { home: "/Users/me", tideHome: "/Users/me/.tide", command: ["/opt/tide/tide-server"], serveArgs: ["--port", "3800"], path: "/opt/homebrew/bin:/usr/bin", explicitTideHome: false };

describe("service files", () => {
  it("launchd: runs `serve --log` with the user's PATH, restarts on crash", () => {
    const spec = serviceSpec({ ...base, platform: "darwin" });
    expect(spec.file).toBe("/Users/me/Library/LaunchAgents/com.tide.server.plist");
    expect(spec.argv).toEqual(["/opt/tide/tide-server", "serve", "--log", "/Users/me/.tide/logs/server.log", "--port", "3800"]);
    const plist = launchdPlist(spec);
    expect(plist).toContain("<string>com.tide.server</string>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>");
    expect(plist).not.toContain("TIDE_HOME");
    expect(plist).toContain("<key>SuccessfulExit</key><false/>");
  });

  it("systemd: quoted ExecStart, TIDE_HOME only when set explicitly", () => {
    const spec = serviceSpec({ ...base, platform: "linux", home: "/home/me", tideHome: "/srv/tide 1", explicitTideHome: true, command: ["/usr/bin/node", "--experimental-strip-types", "/src/bin.ts"] });
    expect(spec.file).toBe("/home/me/.config/systemd/user/tide-server.service");
    const unit = systemdUnit(spec);
    expect(unit).toContain('ExecStart="/usr/bin/node" "--experimental-strip-types" "/src/bin.ts" "serve" "--log" "/srv/tide 1/logs/server.log" "--port" "3800"');
    expect(unit).toContain('Environment="TIDE_HOME=/srv/tide 1"');
    expect(unit).toContain("WantedBy=default.target");
    expect(() => serviceSpec({ ...base, platform: "win32" })).toThrow(/macOS/);
  });

  it("selfCommand re-runs the entry script under node, or the compiled binary alone", () => {
    expect(selfCommand("/bin/tide", "/$bunfs/root/bin.ts", true)).toEqual(["/bin/tide"]);
    const script = join(import.meta.dirname, "service.ts");
    expect(selfCommand("/usr/bin/node", script, false)).toEqual(["/usr/bin/node", "--experimental-strip-types", "--no-warnings=ExperimentalWarning", script]);
  });
});

describe("runService", () => {
  it("install writes the plist and bootstraps it; uninstall removes it", async () => {
    const home = tmp();
    const calls: string[] = [];
    const exec: Exec = async (file, args) => {
      calls.push(`${file} ${args.join(" ")}`);
      return { code: 0, out: "" };
    };
    const deps = { exec, env: { TIDE_HOME: join(home, ".tide"), PATH: "/usr/bin" }, platform: "darwin" as const, home, uid: 501, command: ["/opt/tide"] };
    const installed = await runService("install", [], deps);
    const file = join(home, "Library", "LaunchAgents", "com.tide.server.plist");
    expect(installed.code).toBe(0);
    expect(installed.text).toContain(`wrote ${file}`);
    expect(readFileSync(file, "utf8")).toContain(`<key>TIDE_HOME</key><string>${join(home, ".tide")}</string>`);
    expect(calls).toContain(`launchctl bootstrap gui/501 ${file}`);
    const removed = await runService("uninstall", [], deps);
    expect(removed.text).toContain(`removed ${file}`);
    expect(existsSync(file)).toBe(false);
    expect(calls).toContain("launchctl bootout gui/501/com.tide.server");
  });

  it("status reads the service manager's state", async () => {
    const home = tmp();
    const exec: Exec = async () => ({ code: 0, out: "Active: active (running) since…\n Main PID: 4242 (node)" });
    const status = await runService("status", [], { exec, env: { PATH: "/usr/bin" }, platform: "linux", home, uid: 1000, command: ["/x"] });
    expect(status.code).toBe(0);
    expect(status.text).toContain("running (pid 4242)");
    expect(status.text).toContain("not installed");
  });
});
