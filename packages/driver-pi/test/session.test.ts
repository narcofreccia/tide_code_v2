import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent, OpenSessionOptions } from "@tide/contracts";
import { META_PREFIX, PLAN_PREFIX, USAGE_PREFIX } from "@tide/pi-extensions/protocol";
import { buildSpawn, createPiInstance } from "../src/index.ts";
import type { PiConfig } from "../src/types.ts";
import { baseScript, fakePi, type FakePi, type Script } from "./fake-pi.ts";

const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };

const options: OpenSessionOptions = {
  threadId: "t1",
  cwd: "/tmp/tide-pi-test",
  mode: "approval-required",
  interaction: "default",
  mcpServers: [],
};

/** Opens a session over a scripted fake pi; the driver's own commands go through `baseScript`. */
async function open(script: Script, overrides: Partial<OpenSessionOptions> = {}) {
  const base = baseScript();
  let pi!: FakePi;
  const instance = createPiInstance({} as PiConfig, env, {
    bridgePath: "/tmp/tide-bridge.js",
    spawn: () => {
      pi = fakePi((command, self) => {
        base(command, self);
        script(command, self);
      });
      return pi;
    },
    fetch: async () => ({ ok: false, json: async () => undefined }),
  });
  const session = await instance.openSession({ ...options, ...overrides });
  return { session, instance, pi: () => pi };
}

async function collect(stream: AsyncIterable<NormalizedEvent>): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const APPROVAL_META = JSON.stringify({ requestId: "tide-approval-1", toolName: "bash", toolCallId: "call_1", input: { command: "rm -rf build" } });

describe("PiSession", () => {
  it("announces the session, streams a turn and settles with usage from get_session_stats", async () => {
    const { session } = await open((command, pi) => {
      if (command["type"] !== "prompt") return;
      pi.emitLine({ type: "response", id: command["id"], command: "prompt", success: true });
      pi.emitLine({ type: "message_start", message: { role: "assistant" } });
      pi.emitLine({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" } });
      pi.emitLine({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
      pi.emitLine({ type: "agent_settled" });
    });

    const events = await collect(session.send({ text: "hello" }));
    expect(events[0]).toEqual({ type: "session", nativeSessionId: "/tmp/pi-sessions/thread.jsonl", model: "openai/gpt-5.5" });
    expect(session.nativeSessionId).toBe("/tmp/pi-sessions/thread.jsonl");
    expect(events[1]).toMatchObject({ type: "assistant.delta", delta: "hi" });
    const usage = events.at(-2);
    if (usage?.type !== "usage") throw new Error(`expected usage, got ${usage?.type}`);
    // stats are session totals, so the turn's usage is the delta since the snapshot at open
    expect(usage.usage).toMatchObject({ inputTokens: 100, outputTokens: 100, costUsd: 0.01 });
    expect(usage.contextUsage).toEqual({ used: 1200, window: 200_000 });
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
    await session.close();
  });

  it("settles the running turn when pi dies instead of leaving it hanging", async () => {
    const { session, pi } = await open((command, self) => {
      if (command["type"] !== "prompt") return;
      // prompt is acknowledged, so the turn is live and nothing is pending when pi dies
      self.emitLine({ type: "response", id: command["id"], command: "prompt", success: true });
    });
    const events: NormalizedEvent[] = [];
    const done = (async () => {
      for await (const event of session.send({ text: "hello" })) events.push(event);
    })();
    await new Promise((resolve) => setImmediate(resolve));
    pi().exit(137);
    await done;
    expect(events.at(-1)).toEqual({ type: "settled", status: "error", error: "pi exited with code 137" });
    await session.close();
  });

  it("reports a dead pi as interrupted when the user asked to interrupt", async () => {
    const { session, pi } = await open((command, self) => {
      if (command["type"] !== "prompt") return;
      self.emitLine({ type: "response", id: command["id"], command: "prompt", success: true });
    });
    const events: NormalizedEvent[] = [];
    const done = (async () => {
      for await (const event of session.send({ text: "long job" })) events.push(event);
    })();
    await new Promise((resolve) => setImmediate(resolve));
    await session.interrupt();
    pi().exit(null);
    await done;
    expect(events.at(-1)).toEqual({ type: "settled", status: "interrupted", error: "pi exited with code null" });
  });

  it("shows a confirm from one of the user's own extensions as an approval card", async () => {
    const { session, pi } = await open((command, self) => {
      if (command["type"] !== "prompt") return;
      self.emitLine({ type: "response", id: command["id"], command: "prompt", success: true });
      // no TIDE_META: this used to be answered "no" behind the user's back
      self.emitLine({ type: "extension_ui_request", id: "ui-42", method: "confirm", title: "Deploy to staging?", message: "This pushes the current branch." });
    });
    const events: NormalizedEvent[] = [];
    const done = (async () => {
      for await (const event of session.send({ text: "deploy" })) events.push(event);
    })();
    await new Promise((resolve) => setImmediate(resolve));

    const approval = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "approval" ? [event.activity] : []))[0];
    expect(approval).toMatchObject({ requestId: "ui-42", toolName: "Deploy to staging?", status: "pending", description: "This pushes the current branch." });
    expect(pi().sent.some((command) => command["type"] === "extension_ui_response")).toBe(false);

    await session.respondApproval("ui-42", "accept");
    await new Promise((resolve) => setImmediate(resolve));
    expect(pi().sent.at(-1)).toEqual({ type: "extension_ui_response", id: "ui-42", confirmed: true });

    pi().emitLine({ type: "agent_settled" });
    await done;
    await session.close();
  });

  it("turns a TIDE_META confirm into an approval activity and answers extension_ui_response", async () => {
    const { session, pi } = await open((command, self) => {
      if (command["type"] !== "prompt") return;
      self.emitLine({ type: "response", id: command["id"], command: "prompt", success: true });
      self.emitLine({ type: "extension_ui_request", id: "ui-7", method: "confirm", title: "Allow bash?", message: `${META_PREFIX}${APPROVAL_META}\nRun: rm -rf build` });
    });

    const stream = session.send({ text: "clean up" })[Symbol.asyncIterator]();
    await stream.next(); // session
    const approval = await stream.next();
    if (approval.value?.type !== "activity" || approval.value.activity.kind !== "approval") throw new Error("expected an approval activity");
    const activity = approval.value.activity;
    expect(activity.requestId).toBe("ui-7"); // pi's own ui request id, which the response must echo
    expect(activity.toolName).toBe("bash");
    expect(activity.input).toEqual({ command: "rm -rf build" });
    expect(activity.description).toBe("Run: rm -rf build");
    expect(activity.title).toBe("Allow bash?");

    await session.respondApproval("ui-7", "accept");
    await new Promise((resolve) => setImmediate(resolve));
    expect(pi().sent.at(-1)).toEqual({ type: "extension_ui_response", id: "ui-7", confirmed: true });
    await session.close();
  });

  it("declines by answering confirmed:false", async () => {
    const { session, pi } = await open((command, self) => {
      if (command["type"] !== "prompt") return;
      self.emitLine({ type: "response", id: command["id"], command: "prompt", success: true });
      self.emitLine({ type: "extension_ui_request", id: "ui-8", method: "confirm", message: `${META_PREFIX}${APPROVAL_META}\nRun: rm -rf build` });
    });
    const stream = session.send({ text: "clean up" })[Symbol.asyncIterator]();
    await stream.next();
    await stream.next();
    await session.respondApproval("ui-8", "decline");
    await new Promise((resolve) => setImmediate(resolve));
    expect(pi().sent.at(-1)).toEqual({ type: "extension_ui_response", id: "ui-8", confirmed: false });
    await session.close();
  });

  it("acceptForSession answers later confirms for the same tool without a second card", async () => {
    const { session, pi } = await open((command, self) => {
      if (command["type"] !== "prompt") return;
      self.emitLine({ type: "response", id: command["id"], command: "prompt", success: true });
      self.emitLine({ type: "extension_ui_request", id: "ui-1", method: "confirm", message: `${META_PREFIX}${APPROVAL_META}\nRun: rm -rf build` });
    });
    const events: NormalizedEvent[] = [];
    const stream = session.send({ text: "go" })[Symbol.asyncIterator]();
    await stream.next();
    events.push((await stream.next()).value as NormalizedEvent);
    await session.respondApproval("ui-1", "acceptForSession");
    await new Promise((resolve) => setImmediate(resolve));

    pi().emitLine({ type: "extension_ui_request", id: "ui-2", method: "confirm", message: `${META_PREFIX}${APPROVAL_META}\nRun: rm -rf build` });
    await new Promise((resolve) => setImmediate(resolve));
    expect(pi().sent.at(-1)).toEqual({ type: "extension_ui_response", id: "ui-2", confirmed: true });
    await session.close();
  });

  it("cancels a dialog pi's other extensions raise instead of deadlocking", async () => {
    const { session, pi } = await open((command, self) => {
      if (command["type"] !== "prompt") return;
      self.emitLine({ type: "response", id: command["id"], command: "prompt", success: true });
      self.emitLine({ type: "extension_ui_request", id: "ui-9", method: "select", title: "Pick one", options: ["a", "b"] });
      self.emitLine({ type: "agent_settled" });
    });
    const events = await collect(session.send({ text: "go" }));
    expect(events.some((event) => event.type === "activity" && event.activity.kind === "info")).toBe(true);
    expect(pi().sent.some((command) => command["type"] === "extension_ui_response" && command["cancelled"] === true)).toBe(true);
    await session.close();
  });

  it("maps the plan tool's TIDE_PLAN notify to plan.proposed and ignores TIDE_USAGE noise", async () => {
    const { session } = await open((command, self) => {
      if (command["type"] !== "prompt") return;
      self.emitLine({ type: "response", id: command["id"], command: "prompt", success: true });
      self.emitLine({ type: "tool_execution_start", toolCallId: "call_p", toolName: "tide_propose_plan", args: { plan: "# Plan" } });
      self.emitLine({ type: "extension_ui_request", id: "ui-n", method: "notify", message: `${PLAN_PREFIX}${JSON.stringify({ plan: "# Plan\n\n1. do it" })}` });
      self.emitLine({ type: "tool_execution_end", toolCallId: "call_p", toolName: "tide_propose_plan", result: { content: [{ type: "text", text: "Plan recorded" }] }, isError: false });
      self.emitLine({ type: "extension_ui_request", id: "ui-u", method: "notify", message: `${USAGE_PREFIX}${JSON.stringify({ tokens: 42, contextWindow: 1000 })}` });
      self.emitLine({ type: "agent_settled" });
    }, { interaction: "plan" });

    const events = await collect(session.send({ text: "plan it" }));
    const plan = events.find((event) => event.type === "plan.proposed");
    expect(plan).toEqual({ type: "plan.proposed", markdown: "# Plan\n\n1. do it" });
    // the extension's fallback usage line is a real usage event, alongside the stats-based one
    expect(events.filter((event) => event.type === "usage")).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
    await session.close();
  });

  it("interrupt() sends abort and the turn settles as interrupted", async () => {
    const { session, pi } = await open((command, self) => {
      if (command["type"] !== "prompt") return;
      self.emitLine({ type: "response", id: command["id"], command: "prompt", success: true });
      self.emitLine({ type: "message_start", message: { role: "assistant" } });
    });
    const stream = session.send({ text: "long task" })[Symbol.asyncIterator]();
    await stream.next(); // session
    await session.interrupt();
    expect(pi().sent.some((command) => command["type"] === "abort")).toBe(true);
    pi().emitLine({ type: "message_end", message: { role: "assistant", stopReason: "aborted" } });
    pi().emitLine({ type: "agent_settled" });
    const rest: NormalizedEvent[] = [];
    for (;;) {
      const step = await stream.next();
      if (step.done) break;
      rest.push(step.value);
    }
    expect(rest.at(-1)).toEqual({ type: "settled", status: "interrupted" });
    await session.close();
  });

  it("settles with an error when pi rejects the prompt", async () => {
    const { session } = await open((command, self) => {
      if (command["type"] === "prompt") self.emitLine({ type: "response", id: command["id"], command: "prompt", success: false, error: "agent is streaming" });
    });
    const events = await collect(session.send({ text: "again" }));
    expect(events.at(-1)).toEqual({ type: "settled", status: "error", error: "agent is streaming" });
    await session.close();
  });

  it("refuses a second concurrent turn", async () => {
    const { session } = await open((command, self) => {
      if (command["type"] === "prompt") self.emitLine({ type: "response", id: command["id"], command: "prompt", success: true });
    });
    const first = session.send({ text: "one" })[Symbol.asyncIterator]();
    await first.next();
    expect(() => session.send({ text: "two" })).toThrow(/busy/);
    await session.close();
  });

  it("sends images in pi's ImageContent shape", async () => {
    const { session, pi } = await open((command, self) => {
      if (command["type"] !== "prompt") return;
      self.emitLine({ type: "response", id: command["id"], command: "prompt", success: true });
      self.emitLine({ type: "agent_settled" });
    });
    await collect(session.send({ text: "look", images: [{ mediaType: "image/png", data: "AAA" }] }));
    const prompt = pi().sent.find((command) => command["type"] === "prompt");
    expect(prompt?.["images"]).toEqual([{ type: "image", data: "AAA", mimeType: "image/png" }]);
    await session.close();
  });
});

describe("buildSpawn", () => {
  it("passes the bridge, extra extensions, resume and model, and exports the Tide env", () => {
    const { args, env: spawnEnv } = buildSpawn(
      { ...options, mode: "auto-accept-edits", interaction: "plan", resume: "/tmp/s.jsonl", model: "anthropic/claude-sonnet-4" },
      { extraExtensions: ["/tmp/other.ts"] },
      "/tmp/tide-bridge.js",
    );
    expect(args).toEqual(["--mode", "rpc", "-e", "/tmp/tide-bridge.js", "-e", "/tmp/other.ts", "--session", "/tmp/s.jsonl", "--model", "anthropic/claude-sonnet-4"]);
    expect(spawnEnv["TIDE_RUNTIME_MODE"]).toBe("auto-accept-edits");
    expect(spawnEnv["TIDE_INTERACTION"]).toBe("plan");
    expect(spawnEnv["TIDE_THREAD_ID"]).toBe("t1");
  });

  it("falls back to the configured default model and omits the bridge when it is missing", () => {
    const { args } = buildSpawn(options, { defaultModel: "openai/gpt-5.5" }, undefined);
    expect(args).toEqual(["--mode", "rpc", "--model", "openai/gpt-5.5"]);
  });
});
