import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RotatingLog, teeConsole } from "./logFile.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("RotatingLog", () => {
  it("rotates at the size limit and keeps at most `keep` files", () => {
    const dir = mkdtempSync(join(tmpdir(), "tide-log-"));
    dirs.push(dir);
    const path = join(dir, "logs", "server.log");
    const log = new RotatingLog(path, { maxBytes: 10, keep: 3 });
    for (const line of ["aaaaaaaa\n", "bbbbbbbb\n", "cccccccc\n", "dddddddd\n"]) log.write(line);
    expect(readFileSync(path, "utf8")).toBe("dddddddd\n");
    expect(readFileSync(`${path}.1`, "utf8")).toBe("cccccccc\n");
    expect(readFileSync(`${path}.2`, "utf8")).toBe("bbbbbbbb\n");
    expect(existsSync(`${path}.3`)).toBe(false);
  });

  it("tees console output with a timestamp and level, and can be undone", () => {
    const dir = mkdtempSync(join(tmpdir(), "tide-log-"));
    dirs.push(dir);
    const path = join(dir, "server.log");
    const original = console.error;
    console.error = () => undefined; // keep the test output clean; the tee still calls through
    const undo = teeConsole(new RotatingLog(path), () => new Date(0));
    try {
      console.error("boom %d", 7);
    } finally {
      undo();
      console.error = original;
    }
    expect(readFileSync(path, "utf8")).toBe("1970-01-01T00:00:00.000Z ERROR boom 7\n");
  });
});
