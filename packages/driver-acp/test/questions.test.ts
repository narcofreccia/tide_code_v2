import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { elicitationForm, type DriverEnv, type NormalizedEvent, type OpenSessionOptions, type ProviderSession } from "@tide/contracts";
import { createAcpInstance } from "../src/index.ts";
import { answerOption, isQuestionOptions } from "../src/questions.ts";
import type { AcpPermissionOption, JsonRpcMessage } from "../src/types.ts";
import { FixtureAgent, loadFixture, spawnSeq, type FixtureLine } from "./fake-agent.ts";

const CONFIG = "synthetic/init-config";

function env(): DriverEnv {
  return { dataDir: realpathSync(mkdtempSync(join(tmpdir(), "tide-acp-q-"))), log: () => undefined, instance: { id: "acp:fake", label: "Fake" } };
}

async function open(fixtures: string[], options: Partial<OpenSessionOptions> = {}, e: DriverEnv = env()): Promise<{ agent: FixtureAgent; session: ProviderSession }> {
  const agent = new FixtureAgent(fixtures.flatMap((name) => loadFixture(name, e.dataDir)));
  const instance = createAcpInstance({ command: "fake-agent" }, e, { spawn: agent.spawn });
  const session = await instance.openSession({ threadId: "t1", cwd: e.dataDir, mode: "approval-required", interaction: "default", mcpServers: [], ...options });
  return { agent, session };
}

async function collect(stream: AsyncIterable<NormalizedEvent>, onEvent?: (event: NormalizedEvent) => void | Promise<void>): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    await onEvent?.(event);
  }
  return events;
}

function reply(agent: FixtureAgent, id: string): JsonRpcMessage | undefined {
  return agent.child.received.find((message) => message.id === id && message.method === undefined);
}

const PLAIN: AcpPermissionOption[] = [
  { optionId: "a", name: "Allow", kind: "allow_once" },
  { optionId: "r", name: "Reject", kind: "reject_once" },
];

describe("question-shaped option sets", () => {
  it("plain allow/reject sets are approvals; custom kinds or a repeated kind are questions", () => {
    expect(isQuestionOptions(PLAIN)).toBe(false);
    expect(isQuestionOptions([...PLAIN, { optionId: "x", name: "Maybe", kind: "custom" }])).toBe(true);
    expect(isQuestionOptions([PLAIN[0]!, { optionId: "b", name: "Allow B", kind: "allow_once" }])).toBe(true);
  });

  it("answers map by option name, then optionId; single option is the fallback; otherwise cancel", () => {
    expect(answerOption(PLAIN, "q", { q: "Reject" })).toBe("r");
    expect(answerOption(PLAIN, "q", { q: ["Allow"] })).toBe("a");
    expect(answerOption(PLAIN, "q", { q: "r" })).toBe("r");
    expect(answerOption(PLAIN, "q", { q: "nope" })).toBeUndefined();
    expect(answerOption([PLAIN[0]!], "q", { q: "nope" })).toBe("a");
    expect(answerOption([PLAIN[0]!], "q", undefined)).toBeUndefined();
  });
});

describe("AcpSession user input", () => {
  it("a question-shaped permission becomes a user-input activity; the answer selects the option by name", async () => {
    // full-access would auto-answer an approval: a question is never auto-answered
    const { agent, session } = await open([CONFIG, "synthetic/permission-question"], { mode: "full-access" });
    const events = await collect(session.send({ text: "set up storage" }), async (event) => {
      if (event.type === "activity" && event.activity.kind === "user-input") {
        expect(reply(agent, "perm-q")).toBeUndefined();
        await session.respondUserInput(event.activity.requestId, { [event.activity.questions[0]!.id]: "SQLite" });
      }
    });
    expect(events.filter((event) => event.type === "activity" && event.activity.kind === "approval")).toEqual([]);
    expect(events.find((event) => event.type === "activity" && event.activity.kind === "user-input")).toEqual({
      type: "activity",
      activity: {
        kind: "user-input",
        requestId: "call_q",
        status: "pending",
        questions: [{ id: "call_q", text: "Which database should I use?", options: [{ label: "Postgres" }, { label: "SQLite" }] }],
      },
    });
    expect(agent.mismatches).toEqual([]);
    expect(reply(agent, "perm-q")?.result).toEqual({ outcome: { outcome: "selected", optionId: "sqlite" } });
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
  });

  it("an answer matching no option (several options) is answered cancelled", async () => {
    const { agent, session } = await open([CONFIG, "synthetic/permission-question-cancel"]);
    await collect(session.send({ text: "pick a style" }), async (event) => {
      if (event.type === "activity" && event.activity.kind === "user-input") await session.respondUserInput(event.activity.requestId, { call_s: "Neither" });
    });
    expect(agent.mismatches).toEqual([]);
    expect(reply(agent, "perm-s")?.result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("plain allow/reject permissions still go through respondApproval", async () => {
    const { agent, session } = await open([CONFIG, "synthetic/tool-permission-accept"]);
    const events = await collect(session.send({ text: "change hello to hi" }), async (event) => {
      if (event.type === "activity" && event.activity.kind === "approval") await session.respondApproval(event.activity.requestId, "accept");
    });
    expect(events.some((event) => event.type === "activity" && event.activity.kind === "user-input")).toBe(false);
    expect(agent.mismatches).toEqual([]);
  });

  it("close() answers a pending question cancelled before stopping the agent", async () => {
    const { agent, session } = await open([CONFIG, "synthetic/permission-question-cancel"]);
    let requestId = "";
    const events = await collect(session.send({ text: "pick a style" }), async (event) => {
      if (event.type === "activity" && event.activity.kind === "user-input") {
        requestId = event.activity.requestId;
        await session.close();
      }
    });
    expect(reply(agent, "perm-s")?.result).toEqual({ outcome: { outcome: "cancelled" } });
    expect(agent.child.signals).toEqual(["SIGTERM"]);
    expect(events.at(-1)).toEqual({ type: "settled", status: "interrupted" });
    await session.respondUserInput(requestId, { call_s: "Tabs" }); // late answers are ignored
  });

  it("session/request_user_input: questions pass through and answers come back keyed by question id", async () => {
    const { agent, session } = await open([CONFIG, "synthetic/user-input"]);
    const events = await collect(session.send({ text: "scaffold" }), async (event) => {
      if (event.type === "activity" && event.activity.kind === "user-input") await session.respondUserInput(event.activity.requestId, { lang: ["Go"], name: "tide", other: "x" });
    });
    const activity = events.find((event) => event.type === "activity" && event.activity.kind === "user-input");
    expect(activity).toMatchObject({
      activity: {
        requestId: "input-1",
        questions: [
          { id: "lang", text: "Which language?", options: [{ label: "TypeScript", description: "strict" }, { label: "Go" }] },
          { id: "name", text: "Project name?" },
        ],
      },
    });
    expect(reply(agent, "ui-1")?.result).toEqual({ outcome: { outcome: "answered", answers: { lang: ["Go"], name: "tide" } } });
  });

  it("elicitation/create (Antigravity ask_question) becomes a one-click question; the answer goes back as the option's const", async () => {
    const { agent, session } = await open([CONFIG, "antigravity-1.5/ask-question"]);
    const events = await collect(session.send({ text: "pick" }), async (event) => {
      if (event.type === "activity" && event.activity.kind === "user-input") await session.respondUserInput(event.activity.requestId, { q1: "Blue" });
    });
    const activity = events.find((event) => event.type === "activity" && event.activity.kind === "user-input");
    expect(activity).toMatchObject({ activity: { requestId: "call_39", questions: [{ id: "q1", text: "Pick a colour", options: [{ label: "Red" }, { label: "Blue" }] }] } });
    if (activity?.type !== "activity" || activity.activity.kind !== "user-input") throw new Error("expected a question");
    expect(activity.activity.questions).toHaveLength(1);
    expect(reply(agent, "1")?.result).toEqual({ action: "accept", content: { q1: "2" } });
    expect(agent.mismatches).toEqual([]);
  });

  it("an unanswered elicitation is cancelled on interrupt; an unrenderable one is declined so the agent asks in chat", async () => {
    const { agent, session } = await open([CONFIG, "antigravity-1.5/ask-question"]);
    await collect(session.send({ text: "pick" }), async (event) => {
      if (event.type === "activity" && event.activity.kind === "user-input") await session.interrupt();
    });
    expect(reply(agent, "1")?.result).toEqual({ action: "cancel" });
    expect(elicitationForm({ mode: "url", url: "https://x" })).toBeUndefined();
    expect(elicitationForm({ mode: "form", requestedSchema: { type: "object", properties: { deep: { type: "object" } } } })).toBeUndefined();
  });

  it("an unknown agent request is still answered method-not-found", async () => {
    const { agent, session } = await open([CONFIG, "synthetic/unknown-request"]);
    await collect(session.send({ text: "x" }));
    expect(reply(agent, "u-1")?.error?.code).toBe(-32601);
    expect(agent.mismatches).toEqual([]);
  });
});

describe("commands cache", () => {
  it("commands a session saw are written to disk and listed by a fresh instance before any session", async () => {
    const e = env();
    const { session } = await open([CONFIG, "synthetic/commands-update"], {}, e);
    await collect(session.send({ text: "/help" }));
    const file = join(e.dataDir, "acp-commands", "acp_fake.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(2);

    const fresh = createAcpInstance({ command: "fake-agent" }, e, { spawn: spawnSeq() });
    expect(await fresh.listCommands?.({ cwd: e.dataDir })).toEqual([
      { name: "web", source: "custom", description: "Search the web", argumentHint: "query to search for" },
      { name: "init", source: "custom", description: "create AGENTS.md" },
    ]);
  });

  it("no cache and no session → []", async () => {
    expect(await createAcpInstance({ command: "fake-agent" }, env(), { spawn: spawnSeq() }).listCommands?.({ cwd: "/" })).toEqual([]);
  });

  it("the status probe's throwaway session fills the cache when the agent announces commands", async () => {
    const e = env();
    const lines: FixtureLine[] = loadFixture(CONFIG);
    const at = lines.findIndex((line) => line._dir !== "c2a" && line.id === 1);
    lines.splice(at, 0, { jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess_1", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "compact the context" }] } } });
    const instance = createAcpInstance({ command: "fake-agent" }, e, { spawn: spawnSeq(new FixtureAgent(lines).child) });
    await instance.status();
    expect(await instance.listCommands?.({ cwd: e.dataDir })).toEqual([{ name: "compact", source: "custom", description: "compact the context" }]);
    const fresh = createAcpInstance({ command: "fake-agent" }, e, { spawn: spawnSeq() });
    expect(await fresh.listCommands?.({ cwd: e.dataDir })).toEqual([{ name: "compact", source: "custom", description: "compact the context" }]);
  });
});
