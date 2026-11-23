import { describe, expect, it } from "vitest";
import { RpcException } from "./router.ts";
import { createOpenExternal, openerCommand, type ExecFileFn } from "./workspaceOpen.ts";

function fakeExec(result: { error?: Error; stderr?: string } = {}): { exec: ExecFileFn; calls: [string, string[], number][] } {
  const calls: [string, string[], number][] = [];
  const exec: ExecFileFn = (file, args, options, callback) => {
    calls.push([file, args, options.timeout]);
    callback(result.error ?? null, "", result.stderr ?? "");
  };
  return { exec, calls };
}

describe("workspace.openExternal", () => {
  it("runs the platform opener without a shell", async () => {
    const { exec, calls } = fakeExec();
    const open = createOpenExternal({ exec, platform: "darwin" });
    expect(await open("vscode://file/Users/me/repo")).toEqual({ ok: true });
    expect(calls).toEqual([["open", ["vscode://file/Users/me/repo"], 5000]]);
    expect(openerCommand("linux", "https://x.dev")).toEqual(["xdg-open", ["https://x.dev"]]);
    expect(openerCommand("win32", "cursor://file/C:/r")).toEqual(["rundll32", ["url.dll,FileProtocolHandler", "cursor://file/C:/r"]]);
  });

  it("never hands a Windows URL to cmd, whose parser would run what follows an `&`", () => {
    const [file, args] = openerCommand("win32", "https://x.dev/?a=1&calc|x \"q\"");
    expect(file).toBe("rundll32");
    expect(args).toEqual(["url.dll,FileProtocolHandler", "https://x.dev/?a=1&calc|x%20%22q%22"]);
    expect(openerCommand("win32", "vscode://file/C:/Users/me/My Repo/a.ts:3")[1][1]).toBe("vscode://file/C:/Users/me/My%20Repo/a.ts:3");
  });

  it("refuses schemes outside vscode/cursor/http/https", () => {
    const { exec, calls } = fakeExec();
    const open = createOpenExternal({ exec, platform: "darwin" });
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "not a url", "ssh://host"]) {
      expect(() => open(url)).toThrow(RpcException);
    }
    try {
      void open("file:///x");
    } catch (error) {
      expect((error as RpcException).code).toBe("invalid-params");
    }
    expect(calls).toEqual([]);
  });

  it("names the missing editor when the scheme has no handler", async () => {
    const stderr = "LSOpenURLsWithRole() failed with error -10814 for the URL vscode://file/x.\n";
    const { exec } = fakeExec({ error: new Error("Command failed"), stderr });
    expect(await createOpenExternal({ exec, platform: "darwin" })("vscode://file/x")).toEqual({
      ok: false,
      error: "VS Code is not installed (vscode:// has no handler)",
    });
    const other = fakeExec({ error: new Error("boom"), stderr: "" });
    expect(await createOpenExternal({ exec: other.exec, platform: "linux" })("https://x.dev")).toEqual({ ok: false, error: "boom" });
  });
});
