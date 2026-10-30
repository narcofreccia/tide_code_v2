import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent, OpenSessionOptions } from "@tide/contracts";
import { fakeSpawn, type FakeAppServer } from "./fake-app-server.ts";
import { codexDriver } from "./index.ts";
import { collaborationModeFor } from "./modes.ts";
import { CodexSession, turnInput } from "./session.ts";
import { toSkills, matchSkill } from "./skills.ts";
import { toModelInfo } from "./status.ts";

const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };

// Synthetic frames in the shape of the 0.162 bindings (v2/Model, v2/SkillsListResponse).
const model = {
  id: "gpt-5.6-sol",
  model: "gpt-5.6-sol",
  displayName: "GPT-5.6-Sol",
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "Fast" },
    { reasoningEffort: "medium", description: "Balanced" },
    { reasoningEffort: "high", description: "Deep" },
  ],
};
const skillRows = [
  { name: "deploy", description: "Ship it", path: "/skills/deploy/SKILL.md", scope: "user", enabled: true, pluginId: null, interface: { shortDescription: "Deploy the app" } },
  { name: "off", description: "disabled", path: "/skills/off/SKILL.md", scope: "user", enabled: false, pluginId: null },
];

describe("codex efforts", () => {
  it("maps supportedReasoningEfforts and flags the default", () => {
    const [info] = toModelInfo([model] as unknown as Parameters<typeof toModelInfo>[0], undefined);
    expect(info?.efforts).toEqual([{ id: "low", label: "low" }, { id: "medium", label: "medium", default: true }, { id: "high", label: "high" }]);
  });

  it("puts the effort in the collaboration mode (null when unset)", () => {
    expect(collaborationModeFor("default", "m", "high").settings.reasoning_effort).toBe("high");
    expect(collaborationModeFor("default", "m").settings.reasoning_effort).toBeNull();
  });

  async function open(overrides: Partial<OpenSessionOptions> = {}, configure?: (s: FakeAppServer) => void) {
    const { spawn, last } = fakeSpawn(configure);
    const options: OpenSessionOptions = { threadId: "t", cwd: "/tmp/repo", mode: "approval-required", interaction: "default", mcpServers: [], ...overrides };
    const session = await CodexSession.open({ spawnImpl: spawn, tomlReader: () => undefined }, env, options, "/usr/bin/codex");
    return { session, server: last() };
  }

  async function turn(session: CodexSession, server: FakeAppServer, text: string): Promise<void> {
    server.autoReply = "ok";
    const events: NormalizedEvent[] = [];
    for await (const event of session.send({ text })) events.push(event);
  }

  it("sends the thread's effort on turn/start and follows reconfigure", async () => {
    const { session, server } = await open({ effort: "high" });
    await turn(session, server, "hi");
    let call = server.calls("turn/start")[0]!;
    expect(call["effort"]).toBe("high");
    expect((call["collaborationMode"] as { settings: { reasoning_effort: string } }).settings.reasoning_effort).toBe("high");
    expect(await session.reconfigure({ mode: "approval-required", interaction: "default" })).toBe("applied");
    await turn(session, server, "again");
    call = server.calls("turn/start")[1]!;
    expect(call["effort"]).toBeUndefined();
    expect((call["collaborationMode"] as { settings: { reasoning_effort: unknown } }).settings.reasoning_effort).toBeNull();
    await session.close();
  });
});

describe("codex skills", () => {
  it("lists only enabled skills as source=skill", () => {
    const skills = toSkills({ data: [{ cwd: "/r", skills: skillRows, errors: [] }] } as unknown as Parameters<typeof toSkills>[0]);
    expect(skills.map((s) => s.info)).toEqual([{ name: "deploy", description: "Deploy the app", source: "skill" }]);
  });

  it("turns a leading /skill into a skill input part plus the rest; unknown names pass through", () => {
    const skills = toSkills({ data: [{ cwd: "/r", skills: skillRows, errors: [] }] } as unknown as Parameters<typeof toSkills>[0]);
    expect(turnInput({ text: "/deploy to staging" }, skills)).toEqual([
      { type: "skill", name: "deploy", path: "/skills/deploy/SKILL.md" },
      { type: "text", text: "to staging", text_elements: [] },
    ]);
    expect(turnInput({ text: "/deploy" }, skills)).toEqual([{ type: "skill", name: "deploy", path: "/skills/deploy/SKILL.md" }]);
    expect(turnInput({ text: "/nope x" }, skills)).toEqual([{ type: "text", text: "/nope x", text_elements: [] }]);
    expect(matchSkill("not /deploy", skills)).toBeUndefined();
  });

  it("session: resolves /skill through skills/list once, and listCommands uses the same call", async () => {
    const configure = (s: FakeAppServer): void => void (s.skills = skillRows);
    const { spawn, servers, last } = fakeSpawn(configure);
    const options: OpenSessionOptions = { threadId: "t", cwd: "/tmp/repo", mode: "approval-required", interaction: "default", mcpServers: [] };
    const session = await CodexSession.open({ spawnImpl: spawn, tomlReader: () => undefined }, env, options, "/usr/bin/codex");
    const server = last();
    server.autoReply = "ok";
    for await (const _ of session.send({ text: "/deploy now" })) void _;
    for await (const _ of session.send({ text: "/deploy again" })) void _;
    expect(server.calls("skills/list")).toEqual([{ cwds: ["/tmp/repo"] }]);
    expect(server.calls("turn/start")[0]!["input"]).toEqual([
      { type: "skill", name: "deploy", path: "/skills/deploy/SKILL.md" },
      { type: "text", text: "now", text_elements: [] },
    ]);
    await session.close();

    const instance = await codexDriver.create({ binaryPath: process.execPath, spawnImpl: spawn }, env);
    const before = servers.length;
    expect(await instance.listCommands!({ cwd: "/tmp/other" })).toEqual([{ name: "deploy", description: "Deploy the app", source: "skill" }]);
    expect(servers.length).toBe(before + 1);
    expect(servers.at(-1)!.calls("skills/list")).toEqual([{ cwds: ["/tmp/other"] }]);
  });

  it("instance home becomes CODEX_HOME and instance.env wins over config.env", async () => {
    const { spawn, servers } = fakeSpawn();
    const instance = await codexDriver.create(
      { binaryPath: process.execPath, spawnImpl: spawn, env: { A: "1", B: "1" } },
      { ...env, instance: { id: "codex:work", label: "Work", home: "/h/.codex-work", env: { B: "2" } } },
    );
    await instance.status();
    expect(servers[0]!.env["CODEX_HOME"]).toBe("/h/.codex-work");
    expect(servers[0]!.env["A"]).toBe("1");
    expect(servers[0]!.env["B"]).toBe("2");
  });
});
