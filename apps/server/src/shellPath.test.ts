import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import { applyShellPath, isBarePath, mergePath, readShellPath, type ShellRunner } from "./shellPath.ts";

const join = (...entries: string[]): string => entries.join(delimiter);

/** A runner that answers per flag (`-ilc` / `-lc`) and records the calls. */
function fakeRunner(answers: Record<string, string | Error>): { run: ShellRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: ShellRunner = async (file, args) => {
    calls.push([file, ...args]);
    const answer = answers[args[0] ?? ""];
    if (answer === undefined || answer instanceof Error) throw answer ?? new Error("no answer");
    return answer;
  };
  return { run, calls };
}

const wrapped = (path: string): string => `Last login: today\nnvm loaded\n__TIDE_PATH_START__\n${path}\n__TIDE_PATH_END__\nbye\n`;

describe("readShellPath", () => {
  it("parses the PATH between the markers out of noisy rc output", async () => {
    const { run, calls } = fakeRunner({ "-ilc": wrapped("/a/bin:/usr/bin") });
    expect(await readShellPath({ shell: "/bin/zsh", env: {}, run })).toBe("/a/bin:/usr/bin");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 2)).toEqual(["/bin/zsh", "-ilc"]);
  });

  it("falls back to -lc when -ilc fails or prints no markers", async () => {
    const failing = fakeRunner({ "-ilc": new Error("timeout"), "-lc": wrapped("/b/bin") });
    expect(await readShellPath({ shell: "/bin/zsh", env: {}, run: failing.run })).toBe("/b/bin");
    expect(failing.calls.map((call) => call[1])).toEqual(["-ilc", "-lc"]);
    const silent = fakeRunner({ "-ilc": "no markers here", "-lc": wrapped("/c/bin") });
    expect(await readShellPath({ shell: "/bin/zsh", env: {}, run: silent.run })).toBe("/c/bin");
  });

  it("gives undefined when both attempts fail or the PATH is empty", async () => {
    expect(await readShellPath({ shell: "/bin/zsh", env: {}, run: fakeRunner({}).run })).toBeUndefined();
    expect(await readShellPath({ shell: "/bin/zsh", env: {}, run: fakeRunner({ "-ilc": wrapped(""), "-lc": wrapped("  ") }).run })).toBeUndefined();
  });
});

describe("mergePath", () => {
  it("puts shell entries first, then inherited, then well-known, without duplicates or empties", () => {
    expect(mergePath(join("/nvm/bin", "/usr/bin", "", "/opt/homebrew/bin"), join("/usr/bin", "/bin", "/nvm/bin"), ["/opt/homebrew/bin", "/home/u/.local/bin"])).toBe(
      join("/nvm/bin", "/usr/bin", "/opt/homebrew/bin", "/bin", "/home/u/.local/bin"),
    );
  });

  it("keeps the inherited PATH plus well-known dirs when the shell gave nothing", () => {
    expect(mergePath(undefined, join("/usr/bin", "/bin"), ["/usr/bin", "/usr/local/bin"])).toBe(join("/usr/bin", "/bin", "/usr/local/bin"));
    expect(mergePath(undefined, undefined, [])).toBe("");
  });
});

describe("applyShellPath", () => {
  const bare = join("/usr/bin", "/bin", "/usr/sbin", "/sbin");
  const onlyLocal = (path: string): boolean => path === "/home/u/.local/bin";

  it("adopts the login shell's PATH on darwin and logs one line", async () => {
    const env: NodeJS.ProcessEnv = { PATH: bare, SHELL: "/bin/zsh" };
    const lines: string[] = [];
    await applyShellPath({ platform: "darwin", env, home: "/home/u", exists: onlyLocal, run: fakeRunner({ "-ilc": wrapped(join("/nvm/bin", "/usr/bin")) }).run, log: (l) => lines.push(l) });
    expect(env["PATH"]).toBe(join("/nvm/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/home/u/.local/bin"));
    expect(lines).toEqual(["[path] from /bin/zsh: 6 entries"]);
  });

  it("keeps the order of a PATH that was set up, and only appends what it lacks", async () => {
    const terminal = join("/home/u/.nvm/v20/bin", "/usr/bin", "/bin");
    const env: NodeJS.ProcessEnv = { PATH: terminal, SHELL: "/bin/zsh" };
    await applyShellPath({ platform: "darwin", env, home: "/home/u", exists: () => false, run: fakeRunner({ "-ilc": wrapped(join("/home/u/.nvm/v22/bin", "/usr/bin", "/opt/homebrew/bin")) }).run, log: () => undefined });
    expect(env["PATH"]).toBe(join(terminal, "/home/u/.nvm/v22/bin", "/opt/homebrew/bin"));
  });

  it("tells a bare PATH from one a user set up", () => {
    expect(isBarePath(bare)).toBe(true);
    expect(isBarePath(join("/usr/local/sbin", "/usr/local/bin", "/usr/bin", "/bin"))).toBe(true);
    expect(isBarePath(undefined)).toBe(true);
    expect(isBarePath(join("/opt/homebrew/bin", "/usr/bin"))).toBe(false);
    expect(isBarePath(join("/usr/bin", "/home/u/.local/bin"))).toBe(false);
  });

  it("defaults the shell per platform when SHELL is unset", async () => {
    const { run, calls } = fakeRunner({ "-ilc": wrapped("/x") });
    await applyShellPath({ platform: "linux", env: { PATH: bare }, exists: () => false, run, log: () => undefined });
    expect(calls[0]?.[0]).toBe("/bin/bash");
  });

  it("is a no-op on win32 and with TIDE_NO_SHELL_PATH=1", async () => {
    const { run, calls } = fakeRunner({ "-ilc": wrapped("/x") });
    const lines: string[] = [];
    const win: NodeJS.ProcessEnv = { PATH: "C:\\bin" };
    await applyShellPath({ platform: "win32", env: win, exists: () => true, run, log: (l) => lines.push(l) });
    const opted: NodeJS.ProcessEnv = { PATH: bare, TIDE_NO_SHELL_PATH: "1" };
    await applyShellPath({ platform: "darwin", env: opted, exists: () => true, run, log: (l) => lines.push(l) });
    expect(win["PATH"]).toBe("C:\\bin");
    expect(opted["PATH"]).toBe(bare);
    expect(calls).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("survives a throwing runner and still appends the well-known dirs that exist", async () => {
    const env: NodeJS.ProcessEnv = { PATH: bare, SHELL: "/bin/false" };
    const lines: string[] = [];
    const run: ShellRunner = () => {
      throw new Error("spawn failed");
    };
    await applyShellPath({ platform: "darwin", env, home: "/home/u", exists: onlyLocal, run, log: (l) => lines.push(l) });
    expect(env["PATH"]).toBe(join(bare, "/home/u/.local/bin"));
    expect(lines).toEqual(["[path] could not read PATH from /bin/false; using the inherited PATH plus 1 well-known dirs"]);
  });
});
