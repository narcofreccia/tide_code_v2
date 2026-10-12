import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, resolveConfig } from "./config.ts";

const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "tide-config-"));
  homes.push(dir);
  return dir;
}

describe("resolveConfig — server.json", () => {
  it("creates an identity once and reuses it", () => {
    const dir = home();
    const first = resolveConfig(["--data", ":memory:"], { TIDE_HOME: dir });
    const second = resolveConfig(["--data", ":memory:"], { TIDE_HOME: dir });
    expect(second.token).toBe(first.token);
    expect(second.environmentId).toBe(first.environmentId);
  });

  it("refuses to start on a corrupt file instead of rotating the token", () => {
    const dir = home();
    const file = join(dir, "server.json");
    writeFileSync(file, "{ not json", "utf8");
    expect(() => resolveConfig(["--data", ":memory:"], { TIDE_HOME: dir })).toThrow(ConfigError);
    // the user's file is left exactly as it was
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("refuses a file that lost its token", () => {
    const dir = home();
    writeFileSync(join(dir, "server.json"), JSON.stringify({ environmentId: "env" }), "utf8");
    expect(() => resolveConfig(["--data", ":memory:"], { TIDE_HOME: dir })).toThrow(/missing "environmentId" or "token"/);
  });
});
