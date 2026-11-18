import { describe, expect, it } from "vitest";
import type { UsageRepairResult } from "@tide/contracts";
import { CliError, parseCli, USAGE } from "./args.ts";
import { repairText, runUsageRepair } from "./usage.ts";

describe("parseCli usage", () => {
  it("parses tide usage repair and its flags", () => {
    expect(parseCli(["usage", "repair"])).toEqual({ cmd: "usage", action: "repair", apply: false, includeHeuristic: false });
    expect(parseCli(["usage", "repair", "--apply", "--include-heuristic"])).toEqual({ cmd: "usage", action: "repair", apply: true, includeHeuristic: true });
    expect(() => parseCli(["usage"])).toThrow(CliError);
    expect(() => parseCli(["usage", "summary"])).toThrow(/tide usage repair/);
    expect(() => parseCli(["usage", "repair", "--force"])).toThrow(/unknown argument --force/);
    expect(USAGE).toMatch(/tide usage repair \[--apply\] \[--include-heuristic\]/);
  });
});

const row = (patch: Partial<UsageRepairResult["rows"][number]>): UsageRepairResult["rows"][number] => ({
  threadId: "t",
  threadTitle: "Fix the parser",
  turnId: "u",
  at: 0,
  storedUsd: 162.04822121,
  correctedUsd: 4.4251718,
  evidence: "transcript",
  applied: false,
  ...patch,
});

describe("repairText", () => {
  it("prints the rows, the totals and how to apply on a dry run", () => {
    const text = repairText(
      { rows: [row({}), row({ threadTitle: "x".repeat(60), storedUsd: 9, correctedUsd: 4.5, evidence: "heuristic" })], storedUsd: 171.05, correctedUsd: 8.93, appliedCount: 0 },
      { apply: false, includeHeuristic: false },
    );
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^THREAD\s+STORED\s+CORRECTED\s+EVIDENCE$/);
    expect(lines[1]).toMatch(/^Fix the parser\s+\$162\.05\s+\$4\.43\s+transcript$/);
    expect(lines[2]).toContain(`${"x".repeat(47)}…`);
    expect(text).toContain("Total: $171.05 stored → $8.93 corrected (2 reports).");
    expect(text).toContain("tide usage repair --apply");
  });

  it("says what was applied and what was left", () => {
    const text = repairText(
      { rows: [row({ applied: true }), row({ evidence: "heuristic" })], storedUsd: 1, correctedUsd: 0, appliedCount: 1 },
      { apply: true, includeHeuristic: false },
    );
    expect(text).toMatch(/applied$/m);
    expect(text).toContain("Corrected 1 report.");
    expect(text).toContain("1 heuristic row was left alone; add --include-heuristic");
  });

  it("has a one-liner when there is nothing to repair", () => {
    expect(repairText({ rows: [], storedUsd: 0, correctedUsd: 0, appliedCount: 0 }, { apply: false, includeHeuristic: false })).toMatch(/Nothing to repair/);
  });
});

describe("runUsageRepair", () => {
  it("calls usage.repair with only the flags given", async () => {
    const calls: [string, unknown][] = [];
    const call = async (method: string, params: unknown): Promise<UsageRepairResult> => {
      calls.push([method, params]);
      return { rows: [], storedUsd: 0, correctedUsd: 0, appliedCount: 0 };
    };
    await runUsageRepair({ apply: false, includeHeuristic: false }, call);
    await runUsageRepair({ apply: true, includeHeuristic: true }, call);
    expect(calls).toEqual([
      ["usage.repair", {}],
      ["usage.repair", { apply: true, includeHeuristic: true }],
    ]);
  });
});
