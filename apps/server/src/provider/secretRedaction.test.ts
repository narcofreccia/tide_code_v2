import { afterEach, describe, expect, it } from "vitest";
import type { Activity } from "@tide/contracts";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { ProviderReactor } from "./reactor.ts";
import { DriverRegistry } from "./registry.ts";
import { MIN_SECRET_LENGTH, redactSecretTool, REDACTED, SECRET_MARKER, SecretValues, secretValuesFor } from "./secretRedaction.ts";
import { SessionDirectory } from "./sessions.ts";
import { createFakeDriver, emit } from "./testing/fakeDriver.ts";

const SECRET = "ghp_very_secret_value_123";
const RESULT = `The user provided GITHUB_TOKEN. Use it for this task only.\n${SECRET}`;
const base = { id: "a1", threadId: "t1", turnId: "u1", createdAt: 1, updatedAt: 1 };
const tool = (toolName: string, output: string | undefined, extra: Partial<Activity> = {}): Activity =>
  ({ ...base, kind: "tool", toolUseId: "x", toolName, input: { name: "GITHUB_TOKEN" }, status: "ok", ...(output !== undefined ? { output } : {}), ...extra }) as Activity;
const outputOf = (a: Activity): string | undefined => (a.kind === "tool" ? a.output : undefined);

describe("redactSecretTool", () => {
  it.each([
    "mcp__tide__tide_request_secret",
    "tide_request_secret",
    "tide/tide_request_secret",
    "mcp:tide.tide_request_secret",
    "tide_tide_request_secret",
    "Tide: request secret",
  ])("replaces the result of %s", (name) => {
    const out = outputOf(redactSecretTool(tool(name, RESULT)));
    expect(out).toBe(`The user provided GITHUB_TOKEN. ${SECRET_MARKER}`);
  });

  it("matches an ACP row known only by its title", () => {
    const out = outputOf(redactSecretTool(tool("other", JSON.stringify({ content: [{ type: "text", text: RESULT }] }), { input: { title: "tide_request_secret" } } as Partial<Activity>)));
    expect(out).not.toContain(SECRET);
  });

  it("uses the bare marker when the result has no recognizable head (a JSON-wrapped Codex output)", () => {
    expect(outputOf(redactSecretTool(tool("mcp:tide.tide_request_secret", `{"text":"${SECRET}"}`)))).toBe(SECRET_MARKER);
  });

  it("keeps declined, file and error results readable", () => {
    const declined = "The user declined to provide GITHUB_TOKEN. Do not ask for it in chat.";
    expect(outputOf(redactSecretTool(tool("tide_request_secret", declined)))).toBe(declined);
    const file = "The user provided API_KEY. It is in the file /h/secrets/t/API_KEY (mode 0600); read it from there.";
    expect(outputOf(redactSecretTool(tool("tide_request_secret", file)))).toBe(file);
    const error = "`name` is required";
    expect(outputOf(redactSecretTool(tool("tide_request_secret", error, { status: "error" } as Partial<Activity>)))).toBe(error);
  });

  it("leaves every other tool alone", () => {
    const a = tool("Read", SECRET);
    expect(redactSecretTool(a)).toBe(a);
  });
});

describe("SecretValues", () => {
  it("scrubs a remembered value from every string of a command, returning the same object when clean", () => {
    const values = new SecretValues();
    const clean = { type: "x", text: "hello" };
    values.remember("t1", SECRET);
    expect(values.scrub(clean)).toBe(clean);
    const command = { type: "activity.upsert", activity: { input: { command: `curl -H "token ${SECRET}"` }, output: [`ok ${SECRET}`] } };
    expect(JSON.stringify(values.scrub(command))).not.toContain(SECRET);
    expect(values.scrub(command).activity.input.command).toBe(`curl -H "token ${REDACTED}"`);
    expect(command.activity.output[0]).toBe(`ok ${SECRET}`);
  });

  it("matches the JSON-escaped form of a value", () => {
    const values = new SecretValues();
    const value = 'p"ss\\word';
    values.remember("t1", value);
    const serialized = JSON.stringify({ text: value });
    expect(values.scrubText(serialized)).not.toContain(JSON.stringify(value).slice(1, -1));
  });

  it(`ignores values shorter than ${MIN_SECRET_LENGTH} characters`, () => {
    const values = new SecretValues();
    values.remember("t1", "abc");
    expect(values.has()).toBe(false);
    expect(values.scrubText("abc")).toBe("abc");
  });

  it("forgets a thread's values", () => {
    const values = new SecretValues();
    values.remember("t1", SECRET);
    values.remember("t2", "another-secret");
    values.forget("t1");
    expect(values.scrubText(`${SECRET} another-secret`)).toBe(`${SECRET} ${REDACTED}`);
  });

  it("streams: a value in one chunk is replaced, a value split across chunks is caught by the carry-over", () => {
    const values = new SecretValues();
    values.remember("t1", SECRET);
    expect(values.stream("text", "u1:m", `use ${SECRET} now`)).toBe(`use ${REDACTED} now`);
    const parts = ["token: ghp_very", "_secret_va", "lue_123 done"].map((d) => values.stream("text", "u1:m2", d));
    expect(parts.join("")).toBe(`token: ${REDACTED} done`);
    expect(parts[0]).toBe("token: ");
  });

  it("streams: held text that turns out not to be a value is released by the next chunk or by flush", () => {
    const values = new SecretValues();
    values.remember("t1", SECRET);
    expect(values.stream("text", "u1:m", "see gh")).toBe("see ");
    expect(values.stream("text", "u1:m", "x and ghp_")).toBe("ghx and ");
    expect(values.stream("reasoning", "u1:r", "think g")).toBe("think ");
    expect(values.flush("u2")).toEqual([]);
    expect(values.flush("u1")).toEqual([
      { kind: "text", key: "u1:m", text: "ghp_" },
      { kind: "reasoning", key: "u1:r", text: "g" },
    ]);
    expect(values.flush("u1")).toEqual([]);
  });

  it("passes text through untouched when nothing is remembered", () => {
    expect(new SecretValues().stream("text", "u1:m", "ghp_ anything")).toBe("ghp_ anything");
  });

  it("is one registry per engine", () => {
    const a = {};
    expect(secretValuesFor(a)).toBe(secretValuesFor(a));
    expect(secretValuesFor({})).not.toBe(secretValuesFor(a));
  });
});

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

describe("ProviderReactor: no secret value reaches an event", () => {
  it("redacts the secret tool's result, an echo in another tool, assistant and reasoning text", async () => {
    const store = new EventStore(await openDatabase(":memory:"));
    const engine = new Engine({ store });
    const { driver, control } = createFakeDriver("claude");
    const registry = new DriverRegistry({ env: { dataDir: ":memory:", log: () => undefined } });
    registry.register(driver);
    const sessions = new SessionDirectory({ registry, autoReap: false, log: () => undefined, model: () => engine.getModel() });
    const reactor = new ProviderReactor({ engine, sessions, log: () => undefined });
    reactor.start();
    closers.push(() => {
      reactor.stop();
      store.close();
    });
    const project = (await engine.dispatch({ type: "project.create", title: "T", rootPath: "/repo" })).events[0]?.event;
    if (project?.type !== "project.created") throw new Error("expected project");
    const created = (await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude" })).events[0]?.event;
    if (created?.type !== "thread.created") throw new Error("expected thread");
    const threadId = created.thread.id;
    // what agent.secret.request does when it hands the value to the tool call
    secretValuesFor(engine).remember(threadId, SECRET);

    control.script(
      emit({ type: "activity", activity: { kind: "tool", toolUseId: "s1", toolName: "mcp__tide__tide_request_secret", input: { name: "GITHUB_TOKEN" }, status: "running" } }),
      // the result arrives on a later update that does not repeat the tool name
      emit({ type: "activity", activity: { kind: "tool", toolUseId: "s1", toolName: "", input: undefined, status: "ok", output: RESULT } }),
      emit({ type: "activity", activity: { kind: "tool", toolUseId: "b1", toolName: "Bash", input: { command: `echo ${SECRET}` }, status: "ok", output: SECRET } }),
      emit({ type: "assistant.reasoning", messageKey: "m", delta: `the key is ${SECRET.slice(0, 9)}` }),
      emit({ type: "assistant.reasoning", messageKey: "m", delta: `${SECRET.slice(9)}.` }),
      emit({ type: "assistant.delta", messageKey: "m", delta: `Pushed with ${SECRET}. ` }),
      emit({ type: "assistant.delta", messageKey: "m", delta: "Done, see gh" }),
      emit({ type: "settled", status: "completed" }),
    );
    await engine.dispatch({ type: "turn.request", threadId, text: "push it" });
    await reactor.drain();
    await engine.drain();

    const stored = JSON.stringify(store.readAll());
    expect(stored).not.toContain(SECRET);
    expect(JSON.stringify(engine.getModel())).not.toContain(SECRET);
    const model = engine.getModel();
    const rows = Object.values(model.activities).filter((a) => a.threadId === threadId && a.kind === "tool");
    expect(rows.find((a) => a.kind === "tool" && a.toolUseId === "s1")).toMatchObject({ toolName: "mcp__tide__tide_request_secret", output: `The user provided GITHUB_TOKEN. ${SECRET_MARKER}` });
    expect(rows.find((a) => a.kind === "tool" && a.toolUseId === "b1")).toMatchObject({ input: { command: `echo ${REDACTED}` }, output: REDACTED });
    const reply = Object.values(model.messages).find((m) => m.threadId === threadId && m.role === "assistant");
    // the held-back "gh" is released before the turn settles
    expect(reply?.text).toBe(`Pushed with ${REDACTED}. Done, see gh`);
    expect(reply?.reasoning).toBe(`the key is ${REDACTED}.`);
  });
});
