import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@tide/contracts";
import { OpencodeNormalizer, formQuestions, passthroughPayload } from "./normalize.ts";
import type { OpencodeEvent, WireTokens } from "./wire.ts";

const S = "ses_1";
const tokens = (input: number, output: number, reasoning = 0, read = 0, write = 0): WireTokens => ({ input, output, reasoning, cache: { read, write } });
const ev = (type: string, data: Record<string, unknown>, created = 1): OpencodeEvent => ({ id: "evt", created, type, data: { sessionID: S, ...data } }) as unknown as OpencodeEvent;

function run(events: OpencodeEvent[], options: Partial<ConstructorParameters<typeof OpencodeNormalizer>[0]> = {}): { out: NormalizedEvent[]; n: OpencodeNormalizer } {
  const n = new OpencodeNormalizer({ sessionId: S, ...options });
  return { out: events.flatMap((event) => n.next(event)), n };
}

describe("OpencodeNormalizer", () => {
  it("ignores other sessions and server-wide events", () => {
    const { out } = run([
      { type: "session.text.delta", data: { sessionID: "ses_other", assistantMessageID: "m", ordinal: 0, delta: "x" } } as unknown as OpencodeEvent,
      { type: "provider.updated", data: {} } as unknown as OpencodeEvent,
    ]);
    expect(out).toEqual([]);
  });

  it("puts reasoning and text of one message on the same messageKey", () => {
    const { out } = run([ev("session.reasoning.delta", { assistantMessageID: "m1", ordinal: 0, delta: "think" }), ev("session.text.delta", { assistantMessageID: "m1", ordinal: 0, delta: "hi" })]);
    expect(out).toEqual([
      { type: "assistant.reasoning", messageKey: "m1", delta: "think" },
      { type: "assistant.delta", messageKey: "m1", delta: "hi" },
    ]);
  });

  it("emits a text block whole when it ended without any delta", () => {
    const { out } = run([ev("session.text.ended", { assistantMessageID: "m1", ordinal: 0, text: "whole" })]);
    expect(out).toEqual([{ type: "assistant.delta", messageKey: "m1", delta: "whole" }]);
  });

  it("reports usage as the delta over the turn's baseline, reasoning counted as output", () => {
    const { out } = run(
      [
        ev("session.step.ended", { assistantMessageID: "m", finish: "stop", cost: 0.01, tokens: tokens(100, 10, 5, 50, 2) }),
        ev("session.usage.updated", { cost: 0.5, tokens: tokens(1100, 60, 10, 550, 2) }),
        ev("session.execution.succeeded", {}),
      ],
      { contextWindow: 1000, baseline: { cost: 0.4, tokens: tokens(1000, 50, 0, 500, 0) } },
    );
    const usage = out.find((event) => event.type === "usage");
    if (usage?.type !== "usage") throw new Error("no usage");
    expect(usage.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 2, costUsd: expect.closeTo(0.1, 6) as unknown as number });
    expect(usage.contextUsage).toEqual({ used: 162, window: 1000 });
    expect(out.at(-1)).toEqual({ type: "settled", status: "completed" });
  });

  it("settles a failed execution as an error with the provider's message, once", () => {
    const { out } = run([
      ev("session.step.failed", { assistantMessageID: "m", error: { type: "provider.invalid-request", message: "Model x has been deprecated." } }),
      ev("session.execution.failed", { error: { type: "provider.invalid-request", message: "Model x has been deprecated." } }),
      ev("session.execution.succeeded", {}),
    ]);
    expect(out).toEqual([{ type: "settled", status: "error", error: "provider.invalid-request: Model x has been deprecated." }]);
  });

  it("settles a user interrupt as interrupted", () => {
    const { out } = run([
      ev("session.step.failed", { assistantMessageID: "m", error: { type: "aborted", message: "Step interrupted" } }),
      ev("session.execution.interrupted", { reason: "user" }),
    ]);
    expect(out).toEqual([{ type: "settled", status: "interrupted" }]);
  });

  it("maps the subagent tool to a child row next to the tool row", () => {
    const { out } = run([
      ev("session.tool.input.started", { assistantMessageID: "m", id: "c1", name: "subagent" }),
      ev("session.tool.called", { assistantMessageID: "m", id: "c1", input: { description: "scan the repo", agent: "explore" } }, 10),
      ev("session.tool.success", { assistantMessageID: "m", id: "c1", content: [{ type: "text", text: "found it" }] }, 25),
    ]);
    const kinds = out.map((event) => (event.type === "activity" ? `${event.activity.kind}:${"status" in event.activity ? event.activity.status : ""}` : event.type));
    expect(kinds).toEqual(["tool:running", "child:running", "tool:ok", "child:done"]);
    expect(out[2]).toMatchObject({ activity: { durationMs: 15, output: "found it" } });
  });

  it("approval cards carry the edit diff from the permission metadata", () => {
    const { out } = run([
      ev("permission.asked", { id: "per_1", action: "edit", resources: ["notes.txt"], save: ["*"], metadata: { files: [{ file: "notes.txt", patch: "+tide\n" }] } }),
    ]);
    expect(out[0]).toMatchObject({ activity: { kind: "approval", requestId: "per_1", toolName: "edit", diff: "+tide\n", description: "notes.txt" } });
  });

  it("passes unknown session events and revert/snapshot events through as info rows", () => {
    const { out, n } = run([ev("session.brand.new", { x: 1 }), ev("session.revert.staged", { revert: { messageID: "m" } }), ev("session.renamed", { title: "t" })]);
    expect(out.map((event) => (event.type === "activity" && event.activity.kind === "info" ? event.activity.text : event.type))).toEqual([
      "opencode: session.brand.new",
      "opencode: session.revert.staged",
    ]);
    expect(n.unknownCount).toBe(1);
  });

  it("surfaces worktree events for the thread's own directory only", () => {
    const at = (directory: string): OpencodeEvent => ({ type: "worktree.updated", location: { directory }, data: { projectID: "p" } }) as unknown as OpencodeEvent;
    const { out } = run([at("/repo"), at("/elsewhere")], { directory: "/repo" });
    expect(out).toHaveLength(1);
  });

  it("abort() settles a turn whose stream died", () => {
    const n = new OpencodeNormalizer({ sessionId: S });
    expect(n.abort("stream gone")).toEqual([{ type: "settled", status: "error", error: "stream gone" }]);
    expect(n.abort("again")).toEqual([]);
  });

  it("converts form fields to questions and truncates big pass-through payloads", () => {
    expect(
      formQuestions({
        id: "frm",
        sessionID: S,
        title: "Questions",
        fields: [
          { key: "q0", type: "string", title: "Indent", description: "Tabs or spaces?", options: [{ value: "Tabs", label: "Tabs" }] },
          { key: "q1", type: "multiselect", options: [{ value: "a", label: "A" }] },
          { key: "x", type: "external" },
        ],
      }),
    ).toEqual([
      { id: "q0", text: "Tabs or spaces?", options: [{ label: "Tabs" }] },
      { id: "q1", text: "q1", options: [{ label: "A" }], multi: true },
    ]);
    expect(typeof passthroughPayload({ type: "x", data: { big: "y".repeat(10_000) } })).toBe("string");
  });
});
