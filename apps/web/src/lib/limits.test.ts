import { describe, expect, it } from "vitest";
import type { RateLimit } from "@tide/contracts";
import { limitWindow, selectInstanceLimits, tightestInstance, windowsText } from "./limits.ts";
import { makeThread, modelWith } from "../testHarness.ts";

const lim = (note: string, remainingPct: number | undefined, at = 1, status: RateLimit["status"] = "ok"): RateLimit => ({
  status,
  note,
  at,
  ...(remainingPct === undefined ? {} : { remainingPct }),
});

describe("limits", () => {
  it("reads the window from the harness wording", () => {
    expect(limitWindow(lim("five_hour 40% used", 60))).toBe("5h");
    expect(limitWindow(lim("seven_day_opus 10% used", 90))).toBe("wk");
    expect(limitWindow(lim("codex 12% used (5h window)", 88))).toBe("5h");
    expect(limitWindow(lim("codex 3% used (168h window)", 97))).toBe("wk");
    expect(limitWindow(lim("rate limit", undefined))).toBe("other");
    expect(limitWindow(lim("seven_day_overage_included 100% used (rejected)", 0))).toBe("other");
  });

  it("keeps the newest report per instance and window", () => {
    const model = modelWith({
      threads: {
        a: makeThread("a", { rateLimit: lim("five_hour 10% used", 90, 1) }),
        b: makeThread("b", { rateLimit: lim("five_hour 30% used", 70, 5) }),
        c: makeThread("c", { provider: "codex", providerId: "codex:work", rateLimit: lim("codex 50% used (5h window)", 50, 2) }),
        d: makeThread("d", { rateLimit: lim("five_hour 99% used", 1, 9), archivedAt: 10 }),
      },
    });
    const limits = selectInstanceLimits(model);
    expect(limits.map((l) => l.id)).toEqual(["claude", "codex:work"]);
    expect(limits[0]?.windows["5h"]?.remainingPct).toBe(70);
    expect(tightestInstance(model)?.id).toBe("codex:work");
  });

  it("prints used share per window, limited when limited", () => {
    expect(windowsText({ id: "claude", provider: "claude", windows: { "5h": lim("five_hour", 38), wk: lim("seven_day", 82) } })).toBe("5h 62% · wk 18%");
    expect(windowsText({ id: "claude", provider: "claude", windows: { "5h": lim("five_hour", 0, 1, "limited") } })).toBe("5h limited");
    expect(tightestInstance(modelWith({ threads: { a: makeThread("a", { rateLimit: lim("x", undefined) }) } }))).toBeUndefined();
  });

  it("reads the windows from model.limits when the server keeps them", () => {
    const model = modelWith({
      threads: {
        // a windowed report on a thread is the same one model.limits holds: not read twice
        a: makeThread("a", { rateLimit: { status: "ok", remainingPct: 10, window: "session", at: 1 } }),
        b: makeThread("b", { rateLimit: lim("seven_day_overage_included 5% used", 95, 3) }),
      },
    });
    model.limits = {
      claude: { session: { status: "ok", remainingPct: 40, window: "session", at: 4 }, weekly: { status: "ok", remainingPct: 80, window: "weekly", at: 4 } },
      "codex:work": { weekly: { status: "limited", remainingPct: 0, window: "weekly", at: 2 } },
    };
    const limits = selectInstanceLimits(model);
    expect(limits.map((l) => [l.id, l.provider])).toEqual([["claude", "claude"], ["codex:work", "codex"]]);
    expect(windowsText(limits[0]!)).toBe("5h 60% · wk 20% · limit 5%");
    expect(limits[0]?.windows.other?.remainingPct).toBe(95);
    expect(tightestInstance(model)?.id).toBe("codex:work");
  });

  it("ignores stale Claude/Codex rate limits left on a thread after switching to another harness, and drops expired thread limits", () => {
    const model = modelWith({
      threads: {
        switched: makeThread("switched", {
          provider: "antigravity",
          rateLimit: { status: "limited", remainingPct: 0, resetsAt: 9_000, note: "seven_day 100% used (rejected)", at: 5 },
        }),
        expired: makeThread("expired", {
          provider: "claude",
          rateLimit: { status: "warning", remainingPct: 20, resetsAt: 1_000, note: "seven_day_overage_included 80% used", at: 4 },
        }),
      },
    });
    expect(selectInstanceLimits(model, 5_000)).toEqual([]);
  });
});
