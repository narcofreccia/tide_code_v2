import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@tide/contracts";
import { OpencodeNormalizer } from "../src/normalize.ts";
import type { OpencodeEvent } from "../src/wire.ts";

/**
 * Replays turns recorded from a real `opencode serve` 2.0.27 (free `opencode/big-pickle`
 * model, no login) by `scripts/record-fixture.ts`. The recorder answered every permission
 * with `once` and every form with its first option.
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
});
