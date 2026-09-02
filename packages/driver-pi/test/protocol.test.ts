import { describe, expect, it } from "vitest";
import { META_PREFIX, PLAN_PREFIX, approvalDescription, blockedInPlanMode, classifyTool, isReadOnlyCommand, needsApproval, parseApprovalMeta, parsePrefixedJson, parseRuntimeMode } from "@tide/pi-extensions/protocol";

/**
 * The bridge contract is shared source, so it is tested once, here, on the driver side —
 * both ends import these exact functions.
 */

describe("tool classification", () => {
  it("splits pi's built-in tools into read / write / command", () => {
    expect(["read", "ls", "grep", "find"].map(classifyTool)).toEqual(["read", "read", "read", "read"]);
    expect(["edit", "write"].map(classifyTool)).toEqual(["write", "write"]);
    expect(["bash", "powershell"].map(classifyTool)).toEqual(["command", "command"]);
  });

  it("gives an unmodelled tool its own class instead of calling it a write", () => {
    // "not in Tide's table" is not evidence that a tool mutates anything; it still asks for
    // approval, but it is never hard blocked
    expect(classifyTool("some_mcp_tool")).toBe("unknown");
    expect(needsApproval("approval-required", "unknown")).toBe(true);
    expect(needsApproval("auto-accept-edits", "unknown")).toBe(true);
    expect(needsApproval("auto", "unknown")).toBe(false);
  });
});

describe("plan-mode blocking", () => {
  it("refuses known writes and mutating commands only", () => {
    expect(blockedInPlanMode("write", { path: "a.ts" })).toBe(true);
    expect(blockedInPlanMode("edit", { path: "a.ts" })).toBe(true);
    expect(blockedInPlanMode("bash", { command: "rm -rf build" })).toBe(true);
    expect(blockedInPlanMode("bash", { command: "echo hi > out.txt" })).toBe(true);
  });

  it("lets research through: read tools, read-only shell, and tools Tide does not model", () => {
    expect(blockedInPlanMode("read", { path: "a.ts" })).toBe(false);
    expect(blockedInPlanMode("bash", { command: "git status" })).toBe(false);
    expect(blockedInPlanMode("bash", { command: "rg TODO src | head -20" })).toBe(false);
    // an extension or MCP tool: it reaches the normal approval path instead of being refused
    expect(blockedInPlanMode("some_mcp_tool", { anything: 1 })).toBe(false);
  });

  it("only calls a command read-only when every segment is recognised and nothing redirects", () => {
    expect(isReadOnlyCommand({ command: "ls -la && cat package.json" })).toBe(true);
    expect(isReadOnlyCommand({ command: "git log --oneline" })).toBe(true);
    expect(isReadOnlyCommand({ command: "git push" })).toBe(false);
    expect(isReadOnlyCommand({ command: "cat a.txt > b.txt" })).toBe(false);
    expect(isReadOnlyCommand({ command: "echo $(rm -rf /)" })).toBe(false);
    expect(isReadOnlyCommand({ command: "sudo ls" })).toBe(false);
    expect(isReadOnlyCommand({ command: "ls && npm publish" })).toBe(false);
    expect(isReadOnlyCommand({})).toBe(false);
  });
});

describe("mode policy (docs/internals/providers.md, Pi column)", () => {
  it("approval-required asks for writes and commands", () => {
    expect(needsApproval("approval-required", "read")).toBe(false);
    expect(needsApproval("approval-required", "write")).toBe(true);
    expect(needsApproval("approval-required", "command")).toBe(true);
  });

  it("auto-accept-edits asks only for commands", () => {
    expect(needsApproval("auto-accept-edits", "write")).toBe(false);
    expect(needsApproval("auto-accept-edits", "command")).toBe(true);
  });

  it("auto and full-access never ask", () => {
    for (const mode of ["auto", "full-access"] as const) {
      expect(needsApproval(mode, "write")).toBe(false);
      expect(needsApproval(mode, "command")).toBe(false);
    }
  });

  it("an unset or bogus TIDE_RUNTIME_MODE falls back to the strictest mode", () => {
    expect(parseRuntimeMode(undefined)).toBe("approval-required");
    expect(parseRuntimeMode("yolo")).toBe("approval-required");
    expect(parseRuntimeMode("full-access")).toBe("full-access");
  });
});

describe("message parsing", () => {
  const meta = JSON.stringify({ requestId: "r1", toolName: "bash", toolCallId: "c1", input: { command: "ls" } });

  it("reads the TIDE_META line and the human remainder", () => {
    const message = `${META_PREFIX}${meta}\nRun: ls`;
    expect(parseApprovalMeta(message)).toEqual({ requestId: "r1", toolName: "bash", toolCallId: "c1", input: { command: "ls" } });
    expect(approvalDescription(message)).toBe("Run: ls");
  });

  it("returns undefined for a plain confirm from another extension", () => {
    expect(parseApprovalMeta("Really delete everything?")).toBeUndefined();
    expect(parseApprovalMeta(`${META_PREFIX}{not json`)).toBeUndefined();
    expect(parseApprovalMeta(`${META_PREFIX}{"toolName":"bash"}`)).toBeUndefined(); // no requestId
  });

  it("reads prefixed JSON payloads and ignores everything else", () => {
    expect(parsePrefixedJson<{ plan: string }>(`${PLAN_PREFIX}{"plan":"# P"}`, PLAN_PREFIX)).toEqual({ plan: "# P" });
    expect(parsePrefixedJson("Extension loaded!", PLAN_PREFIX)).toBeUndefined();
    expect(parsePrefixedJson(`${PLAN_PREFIX}oops`, PLAN_PREFIX)).toBeUndefined();
  });
});
