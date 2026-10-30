import { describe, expect, it } from "vitest";
import { modelWith, thread } from "../testing/fixtures.ts";
import { exclusionFrom, isExcluded } from "./dedupe.ts";

describe("Tide-session exclusion", () => {
  const model = modelWith(
    [
      thread("t1", { nativeSessionId: "claude-sess", worktreePath: "/repos/wt-custom" }),
      thread("t2", { provider: "codex", providerSessions: { codex: { nativeSessionId: "codex-thread" }, claude: { nativeSessionId: "older-claude" } } }),
    ],
    [],
  );
  const ex = exclusionFrom(model, "/home/me/.tide");

  it("collects every native session id a thread ran under", () => {
    expect([...ex.sessionIds].sort()).toEqual(["claude-sess", "codex-thread", "older-claude"]);
    expect(isExcluded(ex, { sessionId: "older-claude" })).toBe(true);
    expect(isExcluded(ex, { sessionId: "someone-else" })).toBe(false);
  });

  it("excludes cwds under <tideHome>/worktrees and thread worktrees, not look-alike siblings", () => {
    expect(isExcluded(ex, { cwd: "/home/me/.tide/worktrees/proj/t1" })).toBe(true);
    expect(isExcluded(ex, { cwd: "/home/me/.tide/worktrees" })).toBe(true);
    expect(isExcluded(ex, { cwd: "/home/me/.tide/worktrees-old/x" })).toBe(false);
    expect(isExcluded(ex, { cwd: "/repos/wt-custom/src" })).toBe(true);
    expect(isExcluded(ex, { cwd: "/repos/wt-custom2" })).toBe(false);
  });

  it("keeps everything when there is no tide home and no threads", () => {
    const empty = exclusionFrom(modelWith([], []), undefined);
    expect(isExcluded(empty, { sessionId: "x", cwd: "/anything" })).toBe(false);
  });
});
