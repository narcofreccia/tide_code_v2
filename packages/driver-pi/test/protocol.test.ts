import { describe, expect, it } from "vitest";
import { META_PREFIX, PLAN_PREFIX, approvalDescription, classifyTool, needsApproval, parseApprovalMeta, parsePrefixedJson, parseRuntimeMode } from "@tide/pi-extensions/protocol";

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

  it("treats an unknown tool as a write rather than assuming it is safe", () => {
    expect(classifyTool("some_mcp_tool")).toBe("write");
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
