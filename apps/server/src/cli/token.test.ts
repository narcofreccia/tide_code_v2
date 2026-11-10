import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCli } from "./args.ts";
import { writeRuntime } from "./runtime.ts";
import { rotateToken, TokenError } from "./token.ts";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function home(identity?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "tide-token-"));
  homes.push(dir);
  if (identity !== undefined) writeFileSync(join(dir, "server.json"), JSON.stringify(identity), { mode: 0o644 });
  return dir;
}

describe("tide token rotate", () => {
  it("parses only `token rotate`", () => {
    expect(parseCli(["token", "rotate"])).toEqual({ cmd: "token", action: "rotate" });
    expect(() => parseCli(["token"])).toThrow(/tide token rotate/);
    expect(() => parseCli(["token", "rotate", "--now"])).toThrow(/tide token rotate/);
  });

  it("writes a new token 0600, keeps the other fields, and says no server is running", () => {
    const dir = home({ environmentId: "env-1", token: "old", providers: { claude: { x: 1 } } });
    const text = rotateToken({ env: { TIDE_HOME: dir }, random: () => "new-token" });
    const file = join(dir, "server.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ environmentId: "env-1", token: "new-token", providers: { claude: { x: 1 } } });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(text).toContain("No running server");
    expect(text).toMatch(/must pair again/);
    expect(text).toMatch(/keep working/);
  });

  it("says a restart is needed when the server for this home is running", () => {
    const dir = home({ environmentId: "env-1", token: "old" });
    writeRuntime(dir, { pid: 4242, host: "127.0.0.1", port: 3777, startedAt: 0 });
    const text = rotateToken({ env: { TIDE_HOME: dir }, alive: (pid) => pid === 4242 });
    expect(text).toMatch(/port 3777 \(pid 4242\).*restart it now/);
    expect(JSON.parse(readFileSync(join(dir, "server.json"), "utf8")).token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses without a readable identity", () => {
    expect(() => rotateToken({ env: { TIDE_HOME: home() } })).toThrow(TokenError);
    const broken = home();
    writeFileSync(join(broken, "server.json"), "{nope");
    expect(() => rotateToken({ env: { TIDE_HOME: broken } })).toThrow(/cannot read the identity/);
  });
});
