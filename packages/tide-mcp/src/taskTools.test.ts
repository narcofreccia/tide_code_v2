import { describe, expect, it } from "vitest";
import { parseSchedule, TASK_TOOL_DEFINITIONS } from "./taskTools.ts";

describe("parseSchedule once", () => {
  it("accepts epoch milliseconds and ISO date-times", () => {
    expect(parseSchedule({ kind: "once", at: 1_800_000_000_000 })).toEqual({ kind: "once", at: 1_800_000_000_000 });
    expect(parseSchedule({ kind: "once", at: "2026-11-06T14:30:00Z" })).toEqual({ kind: "once", at: Date.UTC(2026, 10, 6, 14, 30) });
    // no offset: server local time
    expect(parseSchedule({ kind: "once", at: "2026-11-06T14:30" })).toEqual({ kind: "once", at: new Date(2026, 10, 6, 14, 30).getTime() });
  });

  it.each([undefined, "", "tomorrow-ish", Number.NaN, -1, {}])("rejects at=%j", (at) => {
    expect(() => parseSchedule({ kind: "once", at })).toThrow(/schedule\.at/);
  });

  it("names once in the error for an unknown kind and in the tool schema", () => {
    expect(() => parseSchedule({ kind: "yearly" })).toThrow(/once/);
    const schedule = TASK_TOOL_DEFINITIONS.find((d) => d.name === "tide_schedule_task")?.inputSchema as unknown as { properties: { schedule: { description: string } } };
    expect(schedule.properties.schedule.description).toContain('"once"');
  });
});
