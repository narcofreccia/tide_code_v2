import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@tide/contracts";
import { OpencodeNormalizer } from "../src/normalize.ts";
import type { OpencodeEvent } from "../src/wire.ts";

/**
 * Replays turns recorded from a real `opencode serve` (free `opencode/big-pickle` model, no
 * login): 2.0.27 by `scripts/record-fixture.ts`, the `subagent-*` ones 2.0.29 by
 * `test/live.test.ts`. The recorders answered every permission with `once` and every form
 * with its first option.
 */
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function load(name: string): OpencodeEvent[] {
  return readFileSync(join(fixtureDir, `${name}.ndjson`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as OpencodeEvent);
}

function replay(name: string, contextWindow = 200_000): { events: NormalizedEvent[]; normalizer: OpencodeNormalizer } {
  const raw = load(name);
  const sessionId = (raw[0] as { data: { sessionID: string } }).data.sessionID;
  const normalizer = new OpencodeNormalizer({ sessionId, contextWindow });
  return { events: raw.flatMap((event) => normalizer.next(event)), normalizer };
}

const of = <T extends NormalizedEvent["type"]>(events: NormalizedEvent[], type: T): Extract<NormalizedEvent, { type: T }>[] =>
  events.filter((event): event is Extract<NormalizedEvent, { type: T }> => event.type === type);

describe("recorded opencode 2 fixtures", () => {
  it("basic turn: text, reasoning, usage delta, one completed settle, nothing unknown", () => {
    const { events, normalizer } = replay("basic-turn");
    expect(of(events, "assistant.delta").map((event) => event.delta).join("")).toContain("opencode-ok");
    const usage = of(events, "usage")[0];
    expect(usage?.usage?.inputTokens).toBeGreaterThan(0);
    expect(usage?.contextUsage?.window).toBe(200_000);
    expect(of(events, "settled")).toEqual([{ type: "settled", status: "completed" }]);
    expect(events.at(-1)?.type).toBe("settled");
    expect(normalizer.unknownCount).toBe(0);
  });

  it("tool permission: approval card carries the tool and its input, then the tool row completes", () => {
    const { events, normalizer } = replay("tool-permission");
    const approval = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "approval" ? [event.activity] : []))[0];
    expect(approval).toMatchObject({ toolName: "shell", status: "pending", description: "echo hello-from-opencode" });
    expect(approval?.requestId).toMatch(/^per_/);
    expect(approval?.input).toMatchObject({ command: "echo hello-from-opencode" });
    const tools = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "tool" ? [event.activity] : []));
    expect(tools.map((tool) => tool.status)).toEqual(["running", "ok"]);
    expect(tools[1]?.output).toContain("hello-from-opencode");
    expect(tools[1]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(of(events, "settled")).toEqual([{ type: "settled", status: "completed" }]);
    expect(normalizer.unknownCount).toBe(0);
  });

  it("plan turn: the plan agent's final answer becomes a ProposedPlan", () => {
    const { events, normalizer } = replay("plan-turn");
    const plans = of(events, "plan.proposed");
    expect(plans).toHaveLength(1);
    expect(plans[0]?.markdown.trim().length).toBeGreaterThan(0);
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
    expect(normalizer.unknownCount).toBe(0);
  });

  it("question turn: the question tool's form becomes a user-input card with its options", () => {
    const { events, normalizer } = replay("question-turn");
    const input = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "user-input" ? [event.activity] : []))[0];
    expect(input?.requestId).toMatch(/^frm_/);
    expect(input?.questions[0]?.id).toBe("q0");
    expect(input?.questions[0]?.options?.length).toBeGreaterThanOrEqual(2);
    expect(of(events, "settled")).toEqual([{ type: "settled", status: "completed" }]);
    expect(normalizer.unknownCount).toBe(0);
  });

  it("sub-agent turn (2.0.29): the child session's tool nests under the child row; child text and end stay out", () => {
    const raw = load("subagent-turn");
    const sessionId = (raw[0] as { data: { sessionID: string } }).data.sessionID;
    const learned: [string, string, boolean][] = [];
    const normalizer = new OpencodeNormalizer({ sessionId, onChildSession: (child, parent, created) => learned.push([child, parent, created]) });
    const events = raw.flatMap((event) => normalizer.next(event));
    expect(learned).toHaveLength(1);
    expect(learned[0]?.[1]).toBe(sessionId);
    expect(learned[0]?.[2]).toBe(true);
    const activities = events.flatMap((event) => (event.type === "activity" ? [event.activity] : []));
    const child = activities.find((activity) => activity.kind === "child" && activity.status === "done");
    if (child?.kind !== "child") throw new Error("no finished child row");
    expect(child.report).toContain("sub-ok");
    expect(child.report).not.toContain("<subagent");
    const nested = activities.filter((activity) => activity.kind === "tool" && activity.parentToolUseId === child.childKey);
    expect(nested.map((tool) => (tool.kind === "tool" ? [tool.toolName, tool.status] : []))).toEqual([
      ["shell", "running"],
      ["shell", "ok"],
    ]);
    // only the parent's own messages stream as text
    const parentMessages = new Set(raw.flatMap((event) => (event.type === "session.text.delta" && (event as { data: { sessionID: string } }).data.sessionID === sessionId ? [(event as { data: { assistantMessageID: string } }).data.assistantMessageID] : [])));
    expect(of(events, "assistant.delta").every((delta) => parentMessages.has(delta.messageKey))).toBe(true);
    expect(of(events, "settled")).toEqual([{ type: "settled", status: "completed" }]);
    expect(events.at(-1)?.type).toBe("settled");
    expect(normalizer.unknownCount).toBe(0);
  });

  it("sub-agent permission (2.0.29): the child's ask is an approval under the child row; usage adds the child's steps", () => {
    const { events, normalizer } = replay("subagent-permission");
    const activities = events.flatMap((event) => (event.type === "activity" ? [event.activity] : []));
    const child = activities.find((activity) => activity.kind === "child");
    if (child?.kind !== "child") throw new Error("no child row");
    const approval = activities.find((activity) => activity.kind === "approval");
    expect(approval).toMatchObject({ toolName: "shell", parentToolUseId: child.childKey, input: { command: "echo sub-perm-ok" } });
    expect(normalizer.childSessions).toHaveLength(1);
    // parent cumulative total (input 10363, output 86 + 84 reasoning, cache read 12288)
    // + child steps (input 10273 + 600, output 18 + 7 + 20 reasoning, cache read 9728)
    expect(of(events, "usage")[0]?.usage).toMatchObject({ inputTokens: 21236, outputTokens: 215, cacheReadTokens: 22016, cacheWriteTokens: 0 });
    expect(of(events, "settled")).toEqual([{ type: "settled", status: "completed" }]);
    expect(normalizer.unknownCount).toBe(0);
  });
});
