import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DriverEnv } from "@tide/contracts";
import { createPiInstance } from "../src/index.ts";
import { toSlashCommands } from "../src/commands.ts";
import { buildSpawn } from "../src/spawn.ts";
import { listModels, PI_CAPS } from "../src/status.ts";
import type { PiDeps } from "../src/types.ts";
import { baseScript, fakePi, type FakePi, type Script } from "./fake-pi.ts";
import { env as baseEnv, open, options } from "./harness.ts";

// Frames in the shape of docs/rpc-commands.md (1.1.0) § get_commands, § get_available_thinking_levels, § get_available_models.
const commands = [
  { name: "fix-tests", description: "Fix failing tests", source: "prompt" },
  { name: "deploy", source: "extension" },
  { name: "tide-config", source: "extension" },
  { name: "skill:review", description: "Review a diff", source: "skill" },
];
const levels = ["off", "minimal", "low", "medium", "high"];

function script(extra: Script = () => undefined): Script {
  return (command, pi) => {
    const id = command["id"];
    switch (command["type"]) {
      case "get_available_models":
        pi.emitLine({ type: "response", id, command: "get_available_models", success: true, data: { models: [{ id: "claude-x", provider: "anthropic", reasoning: true }, { id: "plain", provider: "openai", reasoning: false }] } });
        return;
      case "get_available_thinking_levels":
        pi.emitLine({ type: "response", id, command: "get_available_thinking_levels", success: true, data: { levels } });
        return;
      case "get_commands":
        pi.emitLine({ type: "response", id, command: "get_commands", success: true, data: { commands } });
        return;
      case "set_thinking_level":
        pi.emitLine({ type: "response", id, command: "set_thinking_level", success: true });
        return;
      default:
        extra(command, pi);
    }
  };
}

function deps(spawned: FakePi[], withBase = false): PiDeps {
  return {
    bridgePath: "/tmp/tide-bridge.js",
    probe: async () => "1.1.0",
    spawn: () => {
      const pi = fakePi(
        withBase
          ? (command, self) => {
              baseScript()(command, self);
              script()(command, self);
            }
          : script(),
      );
      spawned.push(pi);
      return pi;
    },
    fetch: async () => ({ ok: false, json: async () => undefined }),
  };
}

describe("pi efforts", () => {
  it("advertises effort + commands", () => {
    expect(PI_CAPS.effort).toBe(true);
    expect(PI_CAPS.commands).toBe(true);
  });

  it("maps get_available_thinking_levels onto every reasoning model and leaves the rest alone", async () => {
    const spawned: FakePi[] = [];
    const models = await listModels("/bin/pi", {}, deps(spawned), baseEnv);
    const ids = ["off", "minimal", "low", "medium", "high"];
    expect(models.find((m) => m.id === "anthropic/claude-x")?.efforts?.map((e) => e.id)).toEqual(ids);
    expect(models.find((m) => m.id === "openai/plain")?.efforts).toBeUndefined();
  });

  it("starts pi with --thinking and changes it live with set_thinking_level", async () => {
    expect(buildSpawn({ ...options, effort: "high" }, {}, undefined).args).toEqual(expect.arrayContaining(["--thinking", "high"]));
    expect(buildSpawn(options, {}, undefined).args).not.toContain("--thinking");
    const { session, pi } = await open(script(), { effort: "high" });
    expect(await session.reconfigure!({ mode: "approval-required", interaction: "default", effort: "low" })).toBe("applied");
    expect(pi().sent.filter((c) => c["type"] === "set_thinking_level")).toEqual([expect.objectContaining({ level: "low" })]);
    // unchanged -> no call; cleared -> a fresh process (pi has no "default" level to set)
    expect(await session.reconfigure!({ mode: "approval-required", interaction: "default", effort: "low" })).toBe("applied");
    expect(pi().sent.filter((c) => c["type"] === "set_thinking_level")).toHaveLength(1);
    expect(await session.reconfigure!({ mode: "approval-required", interaction: "default" })).toBe("reopen");
    await session.close();
  });
});

describe("pi commands", () => {
  it("lists prompt/extension commands as custom and skill: commands as skill, hiding tide-config", () => {
    expect(toSlashCommands(commands)).toEqual([
      { name: "fix-tests", description: "Fix failing tests", source: "custom" },
      { name: "deploy", source: "custom" },
      { name: "skill:review", description: "Review a diff", source: "skill" },
    ]);
  });

  it("instance.listCommands asks a short-lived rpc process rooted at the cwd", async () => {
    const spawned: FakePi[] = [];
    let cwd = "";
    const d = deps(spawned);
    const instance = createPiInstance({ binaryPath: process.execPath }, baseEnv, { ...d, spawn: (c, a, o) => ((cwd = o.cwd), d.spawn(c, a, o)) });
    const list = await instance.listCommands!({ cwd: "/repo" });
    expect(cwd).toBe("/repo");
    expect(list.map((c) => c.name)).toEqual(["fix-tests", "deploy", "skill:review"]);
    expect(spawned[0]?.sent.map((c) => c["type"])).toEqual(["get_commands"]);
    expect(spawned[0]?.signals.length).toBeGreaterThan(0); // closed afterwards
  });

  it("a /command turn is sent to pi verbatim as the prompt (pi resolves it; unknown ones too)", async () => {
    const { session, pi } = await open(script((command, p) => {
      if (command["type"] === "prompt") p.emitLine({ type: "response", id: command["id"], command: "prompt", success: true, data: { disposition: "handled" } });
    }));
    for await (const _ of session.send({ text: "/fix-tests src" })) void _;
    for await (const _ of session.send({ text: "/not-a-command" })) void _;
    expect(pi().sent.filter((c) => c["type"] === "prompt").map((c) => c["message"])).toEqual(["/fix-tests src", "/not-a-command"]);
    await session.close();
  });
});

describe("pi instance env", () => {
  it("maps instance.home to HOME and lets instance.env win over config.env", async () => {
    const seen: NodeJS.ProcessEnv[] = [];
    const d = deps([], true);
    const driverEnv: DriverEnv = { dataDir: tmpdir(), log: () => undefined, instance: { id: "pi:work", label: "Work", home: "/h/work", env: { B: "2" } } };
    const instance = createPiInstance({ env: { A: "1", B: "1" } }, driverEnv, { ...d, spawn: (c, a, o) => (seen.push(o.env), d.spawn(c, a, o)) });
    await instance.openSession(options);
    expect(seen[0]?.["HOME"]).toBe("/h/work");
    expect(seen[0]?.["A"]).toBe("1");
    expect(seen[0]?.["B"]).toBe("2");
    await instance.dispose();
  });
});
