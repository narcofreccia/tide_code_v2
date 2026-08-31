import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentCommand } from "@tide/contracts";
import type { AgentBackend, AgentContext, AgentDispatchResult, AgentThreadStatus } from "./backend.ts";
import { createTideMcpServer } from "./server.ts";
import { TOOL_DEFINITIONS } from "./tools.ts";

/** In-process stand-in for the Tide server's `agent.*` methods. */
class FakeBackend implements AgentBackend {
  readonly commands: AgentCommand[] = [];
  readonly contextCalls: (string | undefined)[] = [];
  messages: AgentContext["messages"] = [];
  findings: AgentContext["findings"] = [];
  session: AgentContext["session"] | undefined = { id: "sess-1", topic: "caching", phase: "exploring", experts: [] };
  status: AgentThreadStatus = { status: "idle", settled: true, lastAssistantText: "done" };
  nextThreadId = "thread-child";

  async dispatch(command: AgentCommand): Promise<AgentDispatchResult> {
    this.commands.push(command);
    if (command.type !== "thread.delegate") return { seq: 1, events: [] };
    return {
      seq: 1,
      events: [
        {
          seq: 1,
          ts: 1,
          event: {
            type: "thread.created",
            thread: {
              id: this.nextThreadId,
              projectId: "p",
              title: "delegated",
              provider: command.provider,
              mode: "auto",
              interaction: "default",
              status: "idle",
              createdAt: 1,
              updatedAt: 1,
            },
          },
        },
      ],
    };
  }

  async context(sinceMessageId?: string): Promise<AgentContext> {
    this.contextCalls.push(sinceMessageId);
    const from = sinceMessageId === undefined ? 0 : this.messages.findIndex((m) => m.id === sinceMessageId) + 1;
    return {
      threadId: "thread-perf",
      role: "expert",
      expertKey: "perf",
      ...(this.session !== undefined ? { session: this.session } : {}),
      findings: this.findings,
      messages: this.messages.slice(from),
    };
  }

  async threadStatus(): Promise<AgentThreadStatus> {
    return this.status;
  }

  close(): void {
    /* nothing to release */
  }
}

async function connect(backend: AgentBackend): Promise<Client> {
  const server = createTideMcpServer({ backend });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const firstText = (result: unknown): string => {
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  return content?.[0]?.text ?? "";
};

describe("tide-mcp server", () => {
  it("lists every tool with a description and a schema", async () => {
    const client = await connect(new FakeBackend());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOL_DEFINITIONS.map((t) => t.name));
    expect(tools.map((t) => t.name)).toEqual([
      "tide_experts_post_finding",
      "tide_experts_read_findings",
      "tide_experts_send_message",
      "tide_experts_check_messages",
      "tide_experts_synthesize",
      "tide_delegate",
      "tide_delegate_status",
    ]);
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
    }
    await client.close();
  });

  it("posts a finding through agent.dispatch with the session it discovered", async () => {
    const backend = new FakeBackend();
    const client = await connect(backend);
    const result = await client.callTool({ name: "tide_experts_post_finding", arguments: { text: "n+1 in the loader" } });
    expect(firstText(result)).toContain("Finding posted");
    expect(backend.commands[0]).toMatchObject({ type: "experts.finding.post", sessionId: "sess-1", text: "n+1 in the loader" });
    await client.close();
  });

  it("returns only unread messages and advances the cursor", async () => {
    const backend = new FakeBackend();
    backend.messages = [
      { id: "m1", from: "api", to: "perf", text: "first", createdAt: 1 },
      { id: "m2", from: "lead", to: "all", text: "second", createdAt: 2 },
    ];
    const client = await connect(backend);
    const first = await client.callTool({ name: "tide_experts_check_messages", arguments: {} });
    expect(firstText(first)).toContain("first");
    expect(firstText(first)).toContain("second");
    const second = await client.callTool({ name: "tide_experts_check_messages", arguments: {} });
    expect(firstText(second)).toBe("No new messages.");
    expect(backend.contextCalls).toEqual([undefined, "m2"]);
    await client.close();
  });

  it("reads findings and reports an empty board honestly", async () => {
    const backend = new FakeBackend();
    const client = await connect(backend);
    expect(firstText(await client.callTool({ name: "tide_experts_read_findings", arguments: {} }))).toBe("No findings posted yet.");
    backend.findings = [{ id: "f1", author: "api", text: "leaky types", createdAt: 1 }];
    expect(firstText(await client.callTool({ name: "tide_experts_read_findings", arguments: {} }))).toContain("[api] leaky types");
    await client.close();
  });

  it("delegates and then reports the child thread's status", async () => {
    const backend = new FakeBackend();
    const client = await connect(backend);
    const delegated = await client.callTool({ name: "tide_delegate", arguments: { provider: "codex", prompt: "measure it" } });
    expect(firstText(delegated)).toContain('"threadId":"thread-child"');
    expect(firstText(delegated)).toContain("tide_delegate_status");
    expect(backend.commands[0]).toMatchObject({ type: "thread.delegate", provider: "codex", prompt: "measure it" });

    const status = await client.callTool({ name: "tide_delegate_status", arguments: { threadId: "thread-child" } });
    expect(firstText(status)).toContain('"settled": true');
    expect(firstText(status)).toContain("done");
    await client.close();
  });

  it("reports a tool error instead of throwing when an argument is missing", async () => {
    const client = await connect(new FakeBackend());
    const result = await client.callTool({ name: "tide_experts_send_message", arguments: { to: "api" } });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("`text` is required");
    await client.close();
  });

  it("says so when the thread is not on a panel", async () => {
    const backend = new FakeBackend();
    backend.session = undefined;
    const client = await connect(backend);
    const result = await client.callTool({ name: "tide_experts_post_finding", arguments: { text: "x" } });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("not part of an expert panel");
    await client.close();
  });
});
