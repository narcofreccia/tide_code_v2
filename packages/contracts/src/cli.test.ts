import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findBinariesOnPath, findBinaryOnPath, findLocalBinary, pathEntries, prepareSpawn, unwrapCmdShim } from "./cli.ts";

const temps: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "tide-cli-test-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("pathEntries", () => {
  it("reads Path case-insensitively on win32 and strips surrounding quotes", () => {
    expect(pathEntries({ Path: '"C:\\Program Files\\Git\\cmd";C:\\Users\\me\\AppData\\Roaming\\npm;;' }, "win32")).toEqual([
      "C:\\Program Files\\Git\\cmd",
      "C:\\Users\\me\\AppData\\Roaming\\npm",
    ]);
  });

  it("splits PATH on colons on unix", () => {
    expect(pathEntries({ PATH: "/usr/local/bin:/usr/bin:" }, "darwin")).toEqual(["/usr/local/bin", "/usr/bin"]);
  });
});

describe("findBinaryOnPath / findBinariesOnPath", () => {
  it("finds executable files on unix and skips non-executable files and directories", () => {
    const dir = scratch();
    mkdirSync(join(dir, "tool")); // directory with same name must be ignored
    const dir2 = scratch();
    writeFileSync(join(dir2, "tool"), "#!/bin/sh\n");
    // not chmod +x yet
    expect(findBinaryOnPath("tool", { env: { PATH: `${dir}:${dir2}` }, platform: "darwin" })).toBeUndefined();
    chmodSync(join(dir2, "tool"), 0o755);
    expect(findBinaryOnPath("tool", { env: { PATH: `${dir}:${dir2}` }, platform: "darwin" })).toBe(join(dir2, "tool"));
  });

  it("prefers .exe over .cmd in the same directory on win32 and searches well-known dirs", () => {
    const npmDir = scratch();
    const localBin = scratch();
    writeFileSync(join(npmDir, "codex.cmd"), "@echo off\r\n");
    writeFileSync(join(npmDir, "codex.exe"), "MZ");
    writeFileSync(join(localBin, "claude.exe"), "MZ");

    expect(findBinaryOnPath("codex", { env: { Path: npmDir }, platform: "win32", includeWindowsDefaults: false })).toBe(join(npmDir, "codex.exe"));
    expect(findBinariesOnPath("codex", { env: { Path: npmDir }, platform: "win32", includeWindowsDefaults: false })).toEqual([
      join(npmDir, "codex.exe"),
      join(npmDir, "codex.cmd"),
    ]);
    expect(findLocalBinary(localBin, "claude", "win32")).toBe(join(localBin, "claude.exe"));
  });

  it("finds Windows global npm binaries via APPDATA when PATH is missing them", () => {
    const appData = scratch();
    const npmDir = join(appData, "npm");
    mkdirSync(npmDir, { recursive: true });
    writeFileSync(join(npmDir, "codex.cmd"), "@echo off\r\n");

    expect(findBinaryOnPath("codex", { env: { Path: "", APPDATA: appData }, home: scratch(), platform: "win32" })).toBe(join(npmDir, "codex.cmd"));
  });
});

describe("unwrapCmdShim / prepareSpawn", () => {
  it("unwraps standard npm .cmd shims to node + js entrypoint with shell: false", () => {
    const dir = scratch();
    const jsPath = join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    mkdirSync(join(dir, "node_modules", "@openai", "codex", "bin"), { recursive: true });
    writeFileSync(jsPath, "console.log('ok');\n");
    const nodeExe = join(dir, "node.exe");
    writeFileSync(nodeExe, "MZ");
    const cmdPath = join(dir, "codex.cmd");
    writeFileSync(cmdPath, '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');

    expect(unwrapCmdShim(cmdPath)).toBe(jsPath);
    expect(prepareSpawn("codex", ["app-server", "-c", 'k="v"'], { Path: dir }, "win32")).toEqual({
      command: nodeExe,
      args: [jsPath, "app-server", "-c", 'k="v"'],
      shell: false,
      windowsHide: true,
    });
  });

  it("falls back to shell: true for non-Node .cmd scripts on win32", () => {
    const dir = scratch();
    const cmdPath = join(dir, "custom.cmd");
    writeFileSync(cmdPath, "@ECHO off\r\necho hi\r\n");

    expect(prepareSpawn("custom", ["--version"], { Path: dir }, "win32")).toEqual({
      command: cmdPath,
      args: ["--version"],
      shell: true,
      windowsHide: true,
    });
  });

  it("leaves unix spawns untouched", () => {
    expect(prepareSpawn("codex", ["app-server"], { PATH: "/usr/bin" }, "linux")).toEqual({
      command: "codex",
      args: ["app-server"],
      shell: false,
      windowsHide: false,
    });
  });
});
