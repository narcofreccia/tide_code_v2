import type { NormalizedEvent } from "@tide/contracts";
import { describe, expect, it } from "vitest";
import { ApprovalBroker, narrowPermissions } from "./approvals.ts";

const bashSuggestion = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "git status:*" }], behavior: "allow", destination: "localSettings" };

describe("narrowPermissions", () => {
  it("re-targets the CLI's allow-rule and directory suggestions, dropping setMode/deny", () => {
    const out = narrowPermissions(
      [bashSuggestion, { type: "setMode", mode: "acceptEdits", destination: "session" }, { type: "addRules", rules: [], behavior: "deny", destination: "session" }, { type: "addDirectories", directories: ["/x"], destination: "localSettings" }],
      "session",
    );
    expect(out).toEqual([
      { ...bashSuggestion, destination: "session" },
      { type: "addDirectories", directories: ["/x"], destination: "session" },
    ]);
  });
  it("returns undefined when nothing usable", () => {
    expect(narrowPermissions(undefined, "session")).toBeUndefined();
    expect(narrowPermissions([], "session")).toBeUndefined();
    expect(narrowPermissions([{ type: "setMode", mode: "plan", destination: "session" }], "session")).toBeUndefined();
  });
});

describe("ApprovalBroker acceptForSession / acceptAlways", () => {
  function setup() {
    const events: NormalizedEvent[] = [];
    return { events, broker: new ApprovalBroker((event) => events.push(event)) };
  }

  it("uses the CLI's narrow suggestion for the session rule", async () => {
    const { broker } = setup();
    const result = broker.handle("Bash", { command: "git status" }, { toolUseID: "t1", suggestions: [bashSuggestion] });
    broker.respondApproval("t1", "acceptForSession");
    expect(await result).toMatchObject({ behavior: "allow", updatedPermissions: [{ ...bashSuggestion, destination: "session" }] });
  });

  it("uses localSettings for acceptAlways", async () => {
    const { broker } = setup();
    const result = broker.handle("Bash", { command: "git status" }, { toolUseID: "t1", suggestions: [bashSuggestion] });
    broker.respondApproval("t1", "acceptAlways");
    expect(await result).toMatchObject({ updatedPermissions: [{ ...bashSuggestion, destination: "localSettings" }] });
  });

  it("falls back to a whole-tool rule without suggestions", async () => {
    const { broker } = setup();
    const result = broker.handle("Bash", { command: "ls" }, { toolUseID: "t2" });
    broker.respondApproval("t2", "acceptForSession");
    expect(await result).toMatchObject({ updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" }] });
  });

  it("names the MCP server in the approval title", async () => {
    const { broker, events } = setup();
    const result = broker.handle("mcp__db__query", {}, { toolUseID: "t3", title: "Claude wants to query", mcpServer: { name: "db", source: "project" } });
    broker.respondApproval("t3", "decline");
    await result;
    expect(events[0]).toMatchObject({ activity: { kind: "approval", title: 'Claude wants to query - MCP server "db" (project)' } });
  });
});
