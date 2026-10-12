import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { DriverEnv } from "@tide/contracts";
import { assertV2, parseVersion } from "./binary.ts";
import { OpencodeServer, serviceFile, type DiscoverFn, type ServerProcess, type ServerSeams, type SpawnFn } from "./server.ts";

class FakeProcess implements ServerProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signals: (NodeJS.Signals | undefined)[] = [];
  ignoreTerm = false;
  #exit: ((code: number | null) => void)[] = [];

  once(event: "exit" | "error", listener: (value: never) => void): this {
    if (event === "exit") this.#exit.push(listener as (code: number | null) => void);
    return this;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (!(this.ignoreTerm && signal === "SIGTERM")) this.exit(0);
    return true;
  }

  listening(url = "http://127.0.0.1:51234"): void {
    this.stdout.write(`server listening on ${url}\n`);
  }

  exit(code: number | null): void {
    this.exitCode = code;
    for (const listener of this.#exit.splice(0)) listener(code);
  }
}

/** A stand-in `opencode` that answers `--version` like the given release. */
function fakeBinary(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tide-oc-bin-"));
  const file = join(dir, "opencode");
  writeFileSync(file, `#!/bin/sh\necho "${version}"\n`);
  chmodSync(file, 0o755);
  return file;
}

interface Harness {
  spawned: FakeProcess[];
  env: DriverEnv;
  calls: { args: string[]; env: NodeJS.ProcessEnv }[];
  seams: ServerSeams;
  /** resolves with the next spawned child (the version probe before it is a real process) */
  nextSpawn(): Promise<FakeProcess>;
}

function harness(discover: DiscoverFn = async () => undefined): Harness {
  const spawned: FakeProcess[] = [];
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const waiters: ((child: FakeProcess) => void)[] = [];
  const spawn: SpawnFn = (_command, args, options) => {
    calls.push({ args, env: options.env });
    const child = new FakeProcess();
    spawned.push(child);
    waiters.shift()?.(child);
    return child;
  };
  return {
    spawned,
    calls,
    env: { dataDir: tmpdir(), log: () => undefined },
    seams: { spawn, discover, killGraceMs: 20 },
    nextSpawn: () => new Promise((resolve) => waiters.push(resolve)),
  };
}

describe("OpencodeServer", () => {
  it("attaches to the user's shared service when it is running, without spawning", async () => {
    const h = harness(async () => ({ url: "http://127.0.0.1:4096", password: "pw", version: "2.0.27" }));
    const server = new OpencodeServer({ binaryPath: fakeBinary("opencode v2.0.27") }, h.env, h.seams);
    expect(await server.endpoint()).toEqual({ source: "service", url: "http://127.0.0.1:4096", password: "pw", version: "2.0.27" });
    expect(h.spawned).toHaveLength(0);
    await server.dispose();
  });

  it("spawns a private server with a minted password when no service runs, and reuses it", async () => {
    const h = harness();
    const server = new OpencodeServer({ binaryPath: fakeBinary("opencode v2.0.27") }, h.env, h.seams);
    const spawning = h.nextSpawn();
    const pending = server.endpoint();
    (await spawning).listening();
    const endpoint = await pending;
    expect(endpoint).toMatchObject({ source: "spawned", url: "http://127.0.0.1:51234", version: "2.0.27" });
    expect(h.calls[0]?.args).toEqual(["serve", "--port", "0", "--hostname", "127.0.0.1"]);
    expect(h.calls[0]?.env["OPENCODE_SERVER_PASSWORD"]).toBe(endpoint.password);
    expect(await server.endpoint()).toBe(endpoint);
    await server.dispose();
    expect(h.spawned[0]?.signals).toEqual(["SIGTERM"]);
  });

  it("standalone never looks for the shared service", async () => {
    let asked = 0;
    const h = harness(async () => {
      asked++;
      return { url: "http://x", version: "2.0.27" };
    });
    const server = new OpencodeServer({ attach: "standalone", binaryPath: fakeBinary("opencode v2.0.27") }, h.env, h.seams);
    const spawning = h.nextSpawn();
    const pending = server.endpoint();
    (await spawning).listening();
    expect((await pending).source).toBe("spawned");
    expect(asked).toBe(0);
    await server.dispose();
  });

  it("refuses a 1.x binary with the upgrade hint", async () => {
    const h = harness();
    const server = new OpencodeServer({ binaryPath: fakeBinary("1.1.36") }, h.env, h.seams);
    await expect(server.endpoint()).rejects.toThrow("OpenCode 2.x required, found 1.1.36 — run `opencode upgrade --major`");
    expect(h.spawned).toHaveLength(0);
  });

  it("restarts a private server that died, and fails a start that exits before printing a URL", async () => {
    const h = harness();
    const server = new OpencodeServer({ binaryPath: fakeBinary("opencode v2.0.27") }, h.env, h.seams);
    const spawning = h.nextSpawn();
    const first = server.endpoint();
    (await spawning).listening("http://127.0.0.1:1111");
    await first;
    h.spawned[0]?.exit(1);
    const respawning = h.nextSpawn();
    const second = server.endpoint();
    (await respawning).exit(2);
    await expect(second).rejects.toThrow(/exited with code 2/);
    await server.dispose();
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const h = harness();
    const server = new OpencodeServer({ binaryPath: fakeBinary("opencode v2.0.27") }, h.env, h.seams);
    const spawning = h.nextSpawn();
    const pending = server.endpoint();
    const child = await spawning;
    child.ignoreTerm = true;
    child.listening();
    await pending;
    await server.dispose();
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("uses a configured URL and password verbatim", async () => {
    const h = harness();
    const server = new OpencodeServer({ serverUrl: "http://127.0.0.1:4096/", serverPassword: "s" }, h.env, h.seams);
    expect(await server.endpoint()).toEqual({ source: "configured", url: "http://127.0.0.1:4096", password: "s" });
    await server.dispose();
  });

  it("parses both version banners and locates the service registration like @opencode/client", () => {
    expect(parseVersion("opencode v2.0.27\n")).toBe("2.0.27");
    expect(parseVersion("INFO  models.dev refreshing\n1.1.36\n")).toBe("1.1.36");
    expect(() => assertV2("2.0.27")).not.toThrow();
    expect(() => assertV2("1.19.0")).toThrow(/found 1.19.0/);
    expect(serviceFile({ serviceFile: "/x/service.json" })).toBe("/x/service.json");
    expect(serviceFile({}).endsWith(join("opencode", "service.json"))).toBe(true);
  });
});
