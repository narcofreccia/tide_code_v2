import { describe, expect, it } from "vitest";
import { TIDE_COMMANDS, isTideCommand, parseClearCommand } from "./slash.ts";

describe("parseClearCommand", () => {
  it("reads bare /clear and /clear with a prompt", () => {
    expect(parseClearCommand("/clear")).toEqual({ rest: "" });
    expect(parseClearCommand("  /clear  ")).toEqual({ rest: "" });
    expect(parseClearCommand("/clear fix the build\nplease")).toEqual({ rest: "fix the build\nplease" });
  });

  it("leaves prose and other commands alone", () => {
    expect(parseClearCommand("/clearance")).toBeUndefined();
    expect(parseClearCommand("please /clear")).toBeUndefined();
    expect(parseClearCommand("/compact")).toBeUndefined();
  });

  it("lists /clear as a Tide command", () => {
    expect(TIDE_COMMANDS.some((c) => c.name === "clear")).toBe(true);
    expect(isTideCommand("clear")).toBe(true);
  });
});
