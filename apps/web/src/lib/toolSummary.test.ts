import { describe, expect, it } from "vitest";
import { summarizeToolResult } from "./toolSummary.ts";

describe("summarizeToolResult", () => {
  it("reads the message out of a JSON output and pretty-prints the rest", () => {
    const out = summarizeToolResult("SendMessage", { to: "a1", message: "go" }, '{"success":true,"message":"Resuming agent a1d3f1e","resumedAgentId":"a1"}');
    expect(out.line).toBe("Resuming agent a1d3f1e");
    expect(out.detail).toBe(JSON.stringify({ success: true, message: "Resuming agent a1d3f1e", resumedAgentId: "a1" }, null, 2));
  });

  it("prefers summary, then error, and trims long strings to 160 chars", () => {
    expect(summarizeToolResult("X", {}, '{"summary":"short"}').line).toBe("short");
    expect(summarizeToolResult("X", {}, '{"error":"boom"}').line).toBe("boom");
    const long = summarizeToolResult("X", {}, JSON.stringify({ message: "y".repeat(400) })).line;
    expect(long.length).toBe(160);
    expect(long.endsWith("…")).toBe(true);
  });

  it("names the recipient and the start of the message for SendMessage", () => {
    const out = summarizeToolResult("SendMessage", { to: "survey-agent", message: `Resume ${"z".repeat(200)}` }, '{"success":true}');
    expect(out.line.startsWith("to survey-agent: Resume ")).toBe(true);
    expect(out.line.length).toBeLessThanOrEqual("to survey-agent: ".length + 100);
  });

  it("uses the command for Bash and the path for file tools", () => {
    expect(summarizeToolResult("Bash", { command: "pnpm test\necho done" }, "ok").line).toBe("pnpm test");
    expect(summarizeToolResult("Read", { file_path: "/a/b.ts" }, "1 line").line).toBe("/a/b.ts");
    expect(summarizeToolResult("Edit", { file_path: "/a/c.ts" }, undefined).line).toBe("/a/c.ts");
  });

  it("falls back to the first non-empty output line, without a detail for plain text", () => {
    const out = summarizeToolResult("Grep", { pattern: "x" }, "\n\n3 matches\nmore");
    expect(out).toEqual({ line: "3 matches" });
    expect(summarizeToolResult("Grep", {}, undefined).line).toBe("");
  });
});
