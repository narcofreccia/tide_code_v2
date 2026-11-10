import { describe, expect, it } from "vitest";
import type { Activity, ActivityOf, ReadModel } from "@tide/contracts";
import { exportFileName, slugify, threadToMarkdown } from "./threadExport.ts";
import { makeApproval, makeMessage, makePlan, makeThread, makeTool, makeTurn, makeUserInput, modelWith } from "../testHarness.ts";

const CREATED = Date.UTC(2026, 10, 10, 14, 3);

function fixture(): ReadModel {
  const model = modelWith({
    projects: { p1: { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 } },
    threads: { t1: makeThread("t1", { title: "Fix the login", model: "opus", branch: "tide/login", createdAt: CREATED }) },
  });
  model.turns["u1"] = makeTurn("u1");
  model.turns["u2"] = makeTurn("u2", { freshSession: true });
  model.turns["u3"] = makeTurn("u3", { rolledBack: true });
  const messages = [
    makeMessage("m1", { text: "Why does login fail?" }),
    makeMessage("m2", { role: "assistant", text: "Let me look." }),
    makeMessage("m3", { role: "assistant", text: "The token is stale. Fix:\n\n```ts\nrefresh();\n```" }),
    makeMessage("m4", { turnId: "u2", text: "Start over" }),
    makeMessage("m5", { turnId: "u2", role: "assistant", text: "Plan below." }),
    makeMessage("m6", { turnId: "u3", text: "Undo that" }),
  ];
  const child: ActivityOf<"child"> = {
    id: "c1", threadId: "t1", turnId: "u1", createdAt: 1, updatedAt: 1,
    kind: "child", childKey: "k1", name: "Explore", description: "find the token code", status: "done",
  };
  const info: Activity = { id: "i1", threadId: "t1", turnId: "u1", createdAt: 1, updatedAt: 1, kind: "info", text: "Compacted the context" };
  const error: Activity = { id: "e1", threadId: "t1", turnId: "u1", createdAt: 1, updatedAt: 1, kind: "error", text: "rate limited" };
  const activities: Activity[] = [
    makeTool("a1", { toolName: "Bash", input: { command: "pnpm test --run\nexit" }, status: "error", output: "1 failed" }),
    makeTool("a2", { toolName: "Read", input: { file_path: "/repo/src/auth/token.ts" } }),
    makeApproval("a3", { toolName: "Bash", input: { command: "rm -rf dist" }, status: "resolved", decision: "decline" }),
    makeApproval("a4", { status: "resolved", decision: "acceptForSession" }),
    makeUserInput("a5", [{ id: "q1", text: "Which store?" }, { id: "q2", text: "Targets?" }], { status: "resolved", answers: { q1: "redis", q2: ["web", "ios"] } }),
    child,
    info,
    error,
  ];
  for (const m of messages) model.messages[m.id] = m;
  for (const a of activities) model.activities[a.id] = a;
  model.plans["pl1"] = makePlan("pl1", { turnId: "u2" });
  model.threadMessages["t1"] = messages.map((m) => m.id);
  model.threadTimeline["t1"] = [
    { kind: "message", id: "m1" },
    { kind: "message", id: "m2" },
    ...activities.map((a) => ({ kind: "activity" as const, id: a.id })),
    { kind: "message", id: "m3" },
    { kind: "boundary", id: "u2" },
    { kind: "message", id: "m4" },
    { kind: "message", id: "m5" },
    { kind: "plan", id: "pl1" },
    { kind: "message", id: "m6" },
  ];
  return model;
}

const EXPECTED = `# Fix the login

- Project: Tide
- Harness: claude · opus
- Branch: \`tide/login\`
- Created: 2026-11-10 14:03 UTC

### You

Why does login fail?

### Assistant

Let me look.

- Tool: Bash \`pnpm test --run\` (error)
- Tool: Read \`…/src/auth/token.ts\` (ok)
- Approval: Bash \`rm -rf dist\` → declined
- Approval: Edit \`/repo/src/x.ts\` → allowed for the session
- Question: Which store? → redis
- Question: Targets? → web, ios
- Sub-agent: Explore: find the token code (done)
- Note: Compacted the context
- Error: rate limited

The token is stale. Fix:

\`\`\`ts
refresh();
\`\`\`

---

*New session*

### You

Start over

### Assistant

Plan below.

#### Plan (proposed)

## Plan

1. do the thing

### You (rolled back)

Undo that
`;

describe("threadToMarkdown", () => {
  it("writes the header, then every timeline item in order", () => {
    expect(threadToMarkdown(fixture(), "t1")).toBe(EXPECTED);
  });

  it("adds tool output as a fenced block only when asked", () => {
    const md = threadToMarkdown(fixture(), "t1", { includeToolOutput: true });
    expect(md).toContain("- Tool: Bash `pnpm test --run` (error)\n\n  ```\n  1 failed\n  ```\n- Tool: Read");
  });

  it("is empty for an unknown thread", () => {
    expect(threadToMarkdown(fixture(), "nope")).toBe("");
  });
});

describe("export file name", () => {
  it("is <slug>-<date>.md", () => {
    expect(slugify("Fix: the Login (again)!")).toBe("fix-the-login-again");
    expect(slugify("✨")).toBe("thread");
    expect(exportFileName("Fix the login", CREATED)).toBe("fix-the-login-2026-11-10.md");
  });
});
