import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@tide/contracts";
import { CONFIG_COMMAND, ENV_MCP_SERVERS } from "@tide/pi-extensions/protocol";
import { PI_QUESTION_ID, buildSpawn, dialogResponse, splitModelId } from "../src/index.ts";
import type { PiUiRequest } from "../src/types.ts";
import { baseScript } from "./fake-pi.ts";
import { collect, open, options, tick } from "./harness.ts";

/** pi 1.x behaviour: extension dialogs as questions, prompt dispositions, live reconfigure, MCP. */

describe("extension dialogs → user-input", () => {
  it("shows a select as a question with options and answers it with the picked value", async () => {
    const { session, pi } = await open((command, self) => {
      if (command["type"] !== "prompt") return;
      self.emitLine({ type: "response", id: command["id"], command: "prompt", success: true, data: { disposition: "started" } });
      self.emitLine({ type: "extension_ui_request", id: "ui-9", method: "select", title: "Pick a colour", options: ["red", "blue"] });
    });
    const events: NormalizedEvent[] = [];
    const done = (async () => {
      for await (const event of session.send({ text: "go" })) events.push(event);
    })();
    await tick();
    const question = events.find((event) => event.type === "activity" && event.activity.kind === "user-input");
    expect(question).toEqual({
      type: "activity",
      activity: { kind: "user-input", requestId: "ui-9", status: "pending", questions: [{ id: PI_QUESTION_ID, text: "Pick a colour", options: [{ label: "red" }, { label: "blue" }] }] },
    });
    // nothing was auto-cancelled: pi is still waiting on the user
    expect(pi().sent.some((command) => command["type"] === "extension_ui_response")).toBe(false);

    await session.respondUserInput("ui-9", { [PI_QUESTION_ID]: "blue" });
    expect(pi().sent.at(-1)).toEqual({ type: "extension_ui_response", id: "ui-9", value: "blue" });
    pi().emitLine({ type: "agent_settled", aborted: false });
    await done;
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
    await session.close();
  });

  it("maps input/editor answers to `value`, and empty or off-list answers to `cancelled`", () => {
    const input: PiUiRequest = { type: "extension_ui_request", id: "a", method: "input", title: "Name", placeholder: "e.g. Ada" };
    const select: PiUiRequest = { type: "extension_ui_request", id: "b", method: "select", title: "Pick", options: ["x"] };
    const editor: PiUiRequest = { type: "extension_ui_request", id: "c", method: "editor", title: "Edit", prefill: "old" };
    expect(dialogResponse(input, { answer: "Grace" })).toEqual({ value: "Grace" });
    expect(dialogResponse(input, { answer: "  " })).toEqual({ cancelled: true });
    expect(dialogResponse(input, {})).toEqual({ cancelled: true });
    expect(dialogResponse(select, { answer: "y" })).toEqual({ cancelled: true });
    expect(dialogResponse(select, { answer: ["x"] })).toEqual({ value: "x" });
    // an editor may legitimately be emptied
    expect(dialogResponse(editor, { answer: "" })).toEqual({ value: "" });
  });

  it("releases an open dialog with `cancelled` when the turn is interrupted", async () => {
    const { session, pi } = await open((command, self) => {
      if (command["type"] !== "prompt") return;
      self.emitLine({ type: "response", id: command["id"], command: "prompt", success: true, data: { disposition: "started" } });
      self.emitLine({ type: "extension_ui_request", id: "ui-i", method: "input", title: "Name" });
    });
    const stream = session.send({ text: "go" })[Symbol.asyncIterator]();
    await stream.next(); // session
    await tick();
    await session.interrupt();
    expect(pi().sent).toContainEqual({ type: "extension_ui_response", id: "ui-i", cancelled: true });
    await session.close();
  });
});

describe("prompt dispositions (pi 0.99+)", () => {
  it("settles at once when pi says the prompt was `handled` (no run, so no agent_settled)", async () => {
    const { session } = await open((command, self) => {
      if (command["type"] === "prompt") self.emitLine({ type: "response", id: command["id"], command: "prompt", success: true, data: { disposition: "handled" } });
    });
    const events = await collect(session.send({ text: "/my-extension-command" }));
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
    await session.close();
  });

  it("waits for agent_settled on `started` and `queued`", async () => {
    for (const disposition of ["started", "queued"]) {
      const { session, pi } = await open((command, self) => {
        if (command["type"] === "prompt") self.emitLine({ type: "response", id: command["id"], command: "prompt", success: true, data: { disposition } });
      });
      const stream = session.send({ text: "go" })[Symbol.asyncIterator]();
      await stream.next(); // session
      await tick();
      pi().emitLine({ type: "agent_settled", aborted: false });
      const rest: NormalizedEvent[] = [];
      for (;;) {
        const step = await stream.next();
        if (step.done) break;
        rest.push(step.value);
      }
      expect(rest.at(-1)).toEqual({ type: "settled", status: "completed" });
      await session.close();
    }
  });
});

describe("reconfigure", () => {
  const bridgeCommand = [{ name: CONFIG_COMMAND, source: "extension" }];

  it("switches the model in place with set_model", async () => {
    const { session, pi } = await open((command, self) => {
      if (command["type"] === "set_model") self.emitLine({ type: "response", id: command["id"], command: "set_model", success: true, data: { id: "claude-sonnet-5", provider: "anthropic" } });
    });
    expect(await session.reconfigure?.({ mode: "approval-required", interaction: "default", model: "anthropic/claude-sonnet-5" })).toBe("applied");
    expect(pi().sent.find((command) => command["type"] === "set_model")).toMatchObject({ provider: "anthropic", modelId: "claude-sonnet-5" });
    // same model again: nothing to send
    const before = pi().sent.length;
    expect(await session.reconfigure?.({ mode: "approval-required", interaction: "default", model: "anthropic/claude-sonnet-5" })).toBe("applied");
    expect(pi().sent.length).toBe(before);
    await session.close();
  });

  it("reopens for a model pi does not know or a bare pattern", async () => {
    const { session } = await open((command, self) => {
      if (command["type"] === "set_model") self.emitLine({ type: "response", id: command["id"], command: "set_model", success: false, error: "Model not found: x/y" });
    });
    expect(await session.reconfigure?.({ mode: "approval-required", interaction: "default", model: "x/y" })).toBe("reopen");
    expect(await session.reconfigure?.({ mode: "approval-required", interaction: "default", model: "sonnet" })).toBe("reopen");
    await session.close();
  });

  it("changes mode / plan mode live through tide-bridge's /tide-config command", async () => {
    const { session, pi } = await open(
      (command, self) => {
        if (command["type"] === "prompt") self.emitLine({ type: "response", id: command["id"], command: "prompt", success: true, data: { disposition: "handled" } });
      },
      {},
      baseScript({ commands: bridgeCommand }),
    );
    expect(await session.reconfigure?.({ mode: "auto", interaction: "plan" })).toBe("applied");
    expect(pi().sent.find((command) => command["type"] === "prompt")?.["message"]).toBe(`/${CONFIG_COMMAND} {"mode":"auto","plan":true}`);
    await session.close();
  });

  it("reopens when the bridge command is missing, or pi did not treat it as a command", async () => {
    const missing = await open(() => undefined);
    expect(await missing.session.reconfigure?.({ mode: "auto", interaction: "default" })).toBe("reopen");
    expect(missing.pi().sent.some((command) => command["type"] === "prompt")).toBe(false);
    await missing.session.close();

    const started = await open(
      (command, self) => {
        if (command["type"] === "prompt") self.emitLine({ type: "response", id: command["id"], command: "prompt", success: true, data: { disposition: "started" } });
      },
      {},
      baseScript({ commands: bridgeCommand }),
    );
    expect(await started.session.reconfigure?.({ mode: "auto", interaction: "default" })).toBe("reopen");
    await started.session.close();
  });

  it("splits provider/model ids for set_model", () => {
    expect(splitModelId("openrouter/anthropic/claude-x")).toEqual({ provider: "openrouter", modelId: "anthropic/claude-x" });
    expect(splitModelId("sonnet")).toBeUndefined();
    expect(splitModelId("anthropic/*sonnet*")).toBeUndefined();
  });
});

describe("buildSpawn: MCP", () => {
  it("hands Tide's MCP servers to tide-bridge and never disables the user's own", () => {
    const { args, env } = buildSpawn({ ...options, mcpServers: [{ name: "tide", command: "node", args: ["mcp.js"], env: { TIDE_AGENT_TOKEN: "t" } }] }, {}, "/tmp/tide-bridge.js");
    expect(JSON.parse(env[ENV_MCP_SERVERS] ?? "[]")).toEqual([{ name: "tide", command: "node", args: ["mcp.js"], env: { TIDE_AGENT_TOKEN: "t" } }]);
    expect(args).not.toContain("--no-mcp");
    expect(args).not.toContain("--no-extensions");
    expect(buildSpawn(options, {}, undefined).env[ENV_MCP_SERVERS]).toBeUndefined();
  });
});
