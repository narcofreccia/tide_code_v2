import { describe, expect, it } from "vitest";
import { killProcessTree } from "./killTree.ts";

describe("killProcessTree on win32", () => {
  it("runs taskkill /T /F on the pid and sends no signals", async () => {
    const calls: string[][] = [];
    const signals: number[] = [];
    await killProcessTree(1234, "SIGTERM", {
      platform: "win32",
      exec: async (file, args) => void calls.push([file, ...args]),
      kill: (pid) => void signals.push(pid),
      ps: async () => {
        throw new Error("ps must not run on Windows");
      },
    });
    expect(calls).toEqual([["taskkill", "/PID", "1234", "/T", "/F"]]);
    expect(signals).toEqual([]);
  });
});
