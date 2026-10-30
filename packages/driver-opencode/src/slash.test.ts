import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent, OpenSessionOptions } from "@tide/contracts";
import { FakeOpencodeApi } from "../test/fake-api.ts";
import { HttpOpencodeApi } from "./client.ts";
import { OpencodeInstance } from "./instance.ts";
import { routeSlash, toSlashCommands } from "./slash.ts";
import { toModelInfo, capsFor } from "./status.ts";

const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };
const options: OpenSessionOptions = { threadId: "t1", cwd: "/repo", mode: "approval-required", interaction: "default", mcpServers: [] };

// Shapes recorded from `opencode serve` 2.0.29 (GET /api/command, /api/skill, /api/model), trimmed.
const frames: Record<string, unknown> = {
  "/api/command": { location: { directory: "/repo" }, data: [{ name: "review", description: "Review the diff" }, { name: "init" }] },
  "/api/skill": { location: { directory: "/repo" }, data: [{ id: "opencode", name: "opencode", description: "About OpenCode", autoinvoke: true, path: "/builtin/opencode/SKILL.md", content: "# big body" }] },
  "/api/model": {
    location: { directory: "/repo" },
    data: [
      { id: "flint-40b-free", providerID: "opencode", name: "Flint 40B Free", enabled: true, variants: [{ id: "low", settings: { reasoningEffort: "low" } }, { id: "high", settings: { reasoningEffort: "high" } }] },
      { id: "plain", providerID: "opencode", name: "Plain", enabled: true },
    ],
  },
};

function recordedClient(): { api: HttpOpencodeApi; seen: { method: string; path: string; body?: unknown }[] } {
  const seen: { method: string; path: string; body?: unknown }[] = [];
  const fetchImpl = (async (input: string, init?: { method?: string; body?: string }) => {
    const url = new URL(input);
    seen.push({ method: init?.method ?? "GET", path: url.pathname, ...(init?.body ? { body: JSON.parse(init.body) as unknown } : {}) });
    const answer = frames[url.pathname];
    return new Response(answer === undefined ? null : JSON.stringify(answer), { status: answer === undefined ? 204 : 200 });
  }) as unknown as typeof fetch;
  return { api: new HttpOpencodeApi({ url: "http://oc" }, fetchImpl), seen };
}

describe("opencode efforts (Model.variants)", () => {
  it("maps variants to efforts and turns caps.effort on only when some model has them", async () => {
    const { api } = recordedClient();
    const models = toModelInfo(await api.models({ directory: "/repo" }), undefined);
    expect(models[0]?.efforts).toEqual([{ id: "low", label: "low" }, { id: "high", label: "high" }]);
    expect(models[1]?.efforts).toBeUndefined();
    expect(capsFor([], models).effort).toBe(true);
    expect(capsFor([], [models[1]!]).effort).toBe(false);
  });

  it("puts the effort on the session's model ref at create, and re-sends the model on reconfigure", async () => {
    const api = new FakeOpencodeApi();
    const instance = new OpencodeInstance({ serverUrl: "http://x", apiImpl: api }, env);
    const session = await instance.openSession({ ...options, model: "opencode/big-pickle", effort: "high" });
    expect(api.created[0]?.model).toEqual({ providerID: "opencode", id: "big-pickle", variant: "high" });
    expect(await session.reconfigure!({ model: "opencode/big-pickle", effort: "low", mode: "approval-required", interaction: "default" })).toBe("applied");
    expect(api.modelSwitches.at(-1)).toEqual({ providerID: "opencode", id: "big-pickle", variant: "low" });
    expect(await session.reconfigure!({ model: "opencode/big-pickle", mode: "approval-required", interaction: "default" })).toBe("applied");
    expect(api.modelSwitches.at(-1)).toEqual({ providerID: "opencode", id: "big-pickle" });
    await session.close();
    await instance.dispose();
  });

  it("an effort without a pinned model pins the server's default model with the variant", async () => {
    const api = new FakeOpencodeApi();
    const instance = new OpencodeInstance({ serverUrl: "http://x", apiImpl: api }, env);
    const session = await instance.openSession({ ...options, effort: "max" });
    expect(api.created[0]?.model).toEqual({ providerID: "opencode", id: "big-pickle", variant: "max" });
    await session.close();
    await instance.dispose();
  });
});

describe("opencode commands and skills", () => {
  it("reads /api/command and /api/skill and lists custom commands before skills", async () => {
    const { api, seen } = recordedClient();
    const catalog = { commands: await api.commands({ directory: "/repo" }), skills: await api.skills({ directory: "/repo" }) };
    expect(seen.map((r) => r.path)).toEqual(["/api/command", "/api/skill"]);
    expect(toSlashCommands(catalog)).toEqual([
      { name: "review", description: "Review the diff", source: "custom" },
      { name: "init", source: "custom" },
      { name: "opencode", description: "About OpenCode", source: "skill" },
    ]);
  });

  it("routes /command to POST …/command, /skill to a skill attachment, unknown /x verbatim", () => {
    const catalog = { commands: [{ name: "review" }], skills: [{ id: "opencode", name: "opencode" }] };
    expect(routeSlash("/review src/a.ts", catalog)).toEqual({ kind: "command", name: "review", text: "src/a.ts" });
    expect(routeSlash("/opencode how do plugins work", catalog)).toEqual({
      kind: "skill",
      skill: { id: "opencode", mention: { start: 0, end: 9, text: "/opencode" } },
      text: "/opencode how do plugins work",
    });
    expect(routeSlash("/nope hi", catalog)).toEqual({ kind: "prompt", text: "/nope hi" });
    expect(routeSlash("plain", catalog)).toEqual({ kind: "prompt", text: "plain" });
  });

  it("the HTTP client sends the command body and skill attachments to the documented routes", async () => {
    const { api, seen } = recordedClient();
    await api.runCommand({ sessionId: "ses_1", name: "review", text: "x" });
    await api.prompt({ sessionId: "ses_1", text: "/opencode hi", skills: [{ id: "opencode" }] });
    expect(seen).toEqual([
      { method: "POST", path: "/api/session/ses_1/command", body: { name: "review", text: "x" } },
      { method: "POST", path: "/api/session/ses_1/prompt", body: { text: "/opencode hi", skills: [{ id: "opencode" }] } },
    ]);
  });

  it("a session turn starting with /command goes through the command route; unknown stays a prompt", async () => {
    const api = new FakeOpencodeApi();
    api.commandList = [{ name: "review" }];
    api.skillList = [{ id: "opencode", name: "opencode" }];
    const instance = new OpencodeInstance({ serverUrl: "http://x", apiImpl: api }, env);
    expect((await instance.listCommands({ cwd: "/repo" })).map((c) => c.name)).toEqual(["review", "opencode"]);
    const session = await instance.openSession(options);
    const run = async (text: string): Promise<void> => {
      const events: NormalizedEvent[] = [];
      const done = (async () => {
        for await (const e of session.send({ text })) events.push(e);
      })();
      await new Promise((r) => setTimeout(r, 0));
      api.succeeded();
      await done;
    };
    await run("/review now");
    await run("/opencode explain");
    await run("/unknown thing");
    expect(api.commandRuns).toEqual([{ sessionId: "ses_fake", name: "review", text: "now" }]);
    expect(api.prompts.map((p) => [p.text, p.skills?.[0]?.id])).toEqual([["/opencode explain", "opencode"], ["/unknown thing", undefined]]);
    await session.close();
    await instance.dispose();
  });

  it("degrades to [] when /api/command is missing", async () => {
    const api = new FakeOpencodeApi();
    api.commandsError = new Error("HTTP 404");
    const instance = new OpencodeInstance({ serverUrl: "http://x", apiImpl: api }, env);
    expect(await instance.listCommands({ cwd: "/repo" })).toEqual([]);
    await instance.dispose();
  });
});
