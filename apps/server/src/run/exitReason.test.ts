import { describe, expect, it } from "vitest";
import { exitReason, isFailedExit, pickErrorLine } from "./exitReason.ts";

describe("pickErrorLine", () => {
  it("prefers the last cause line over a later generic error line", () => {
    const tail = "Compiling x\r\n\x1b[1;31merror\x1b[0m: failed to run custom build command\r\n  resource path `binaries/ffmpeg` doesn't exist\r\nerror: could not compile `x`\r\n";
    expect(pickErrorLine(tail)).toBe("resource path `binaries/ffmpeg` doesn't exist");
  });

  it("falls back to the last error line, then to the last non-empty line", () => {
    expect(pickErrorLine("ok\nnpm ERR! code 1\ndone\n")).toBe("npm ERR! code 1");
    expect(pickErrorLine("starting\nbye\n\n  \n")).toBe("bye");
    expect(pickErrorLine("")).toBeUndefined();
  });

  it("skips the shell echo of the command and the shell's exit line", () => {
    expect(pickErrorLine("$ npm run tauri -- dev; exit\r\nlast words\r\nexit\r\n")).toBe("last words");
  });

  it("clips long lines", () => {
    const line = pickErrorLine(`error: ${"x".repeat(500)}`);
    expect(line).toHaveLength(200);
    expect(line?.endsWith("…")).toBe(true);
  });
});

describe("exitReason", () => {
  it("names the code or signal and the best line", () => {
    expect(exitReason({ code: 101 }, "error: boom\n")).toBe("exited with code 101 — error: boom");
    expect(exitReason({ signal: "SIGSEGV" }, "")).toBe("killed by SIGSEGV");
    expect(exitReason({ code: 0 }, "error: boom")).toBe("exited");
    expect(exitReason({}, "")).toBe("exited");
  });

  it("tells a failed exit from a clean one", () => {
    expect(isFailedExit({ code: 1 })).toBe(true);
    expect(isFailedExit({ signal: "SIGTERM" })).toBe(true);
    expect(isFailedExit({ code: 0 })).toBe(false);
    expect(isFailedExit({})).toBe(false);
  });
});
