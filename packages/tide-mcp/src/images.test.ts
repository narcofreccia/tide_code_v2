import { describe, expect, it } from "vitest";
import type { AgentCommand } from "@tide/contracts";
import type { AgentBackend, AgentDispatchResult, ThreadSendInput, ThreadSendResult } from "./backend.ts";
import { BoardState, callTool } from "./server.ts";
import { THREAD_TOOLS_HINT } from "./threadTools.ts";
import { TOOL_DEFINITIONS } from "./tools.ts";

// R22: tide_delegate / tide_thread_send take image paths and forward them as `imagePaths`.

class ImageBackend {
  readonly dispatched: { command: AgentCommand; imagePaths: string[] | undefined }[] = [];
  readonly sent: ThreadSendInput[] = [];

  async dispatch(command: AgentCommand, imagePaths?: string[]): Promise<AgentDispatchResult> {
    this.dispatched.push({ command, imagePaths });
    const thread = { id: "child", projectId: "p", title: "d", provider: "claude" as const, mode: "auto" as const, interaction: "default" as const, status: "idle" as const, createdAt: 1, updatedAt: 1 };
    return { seq: 1, events: [{ seq: 1, ts: 1, event: { type: "thread.created", thread } }] };
  }

  async threadSend(input: ThreadSendInput): Promise<ThreadSendResult> {
    this.sent.push(input);
    return { turnId: "u1", delivered: "started" };
  }
}

function call(b: ImageBackend, name: string, args: Record<string, unknown>): ReturnType<typeof callTool> {
  const backend = b as unknown as AgentBackend;
  return callTool(backend, new BoardState(backend), name, args);
}

describe("image paths on the delegation tools (R22)", () => {
  it("both tool schemas take `images`, an array of at most 8 paths", () => {
    for (const name of ["tide_delegate", "tide_thread_send"]) {
      const images = TOOL_DEFINITIONS.find((t) => t.name === name)?.inputSchema.properties["images"];
      expect(images).toMatchObject({ type: "array", items: { type: "string" }, maxItems: 8 });
    }
  });

  it("tide_delegate forwards `images` as imagePaths, and nothing when absent or empty", async () => {
    const b = new ImageBackend();
    await call(b, "tide_delegate", { provider: "codex", prompt: "look", images: [".tide/attachments/M/image-1.png", 3, ""] });
    await call(b, "tide_delegate", { provider: "codex", prompt: "look" });
    await call(b, "tide_delegate", { provider: "codex", prompt: "look", images: [] });
    expect(b.dispatched.map((d) => d.imagePaths)).toEqual([[".tide/attachments/M/image-1.png"], undefined, undefined]);
    expect(b.dispatched[0]?.command).not.toHaveProperty("images");
  });

  it("tide_thread_send forwards `images` as imagePaths", async () => {
    const b = new ImageBackend();
    await call(b, "tide_thread_send", { threadId: "t1", text: "see", images: ["shot.png"] });
    await call(b, "tide_thread_send", { threadId: "t1", text: "plain" });
    expect(b.sent).toEqual([{ threadId: "t1", text: "see", imagePaths: ["shot.png"] }, { threadId: "t1", text: "plain" }]);
  });

  it("the hint says how attached images reach a sub-agent and another thread", () => {
    expect(THREAD_TOOLS_HINT).toContain("pass the paths in `images` to tide_delegate or tide_thread_send");
  });
});
