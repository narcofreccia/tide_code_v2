import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DriverEnv, LinkedDir, NormalizedEvent, OpenSessionOptions } from "@tide/contracts";
import { ApprovalBroker } from "./approvals.ts";
import { isUnder, readOnlyLinkFor } from "./links.ts";
import { ClaudeSession } from "./session.ts";
import type { QueryFn } from "./types.ts";

async function collectNothing(stream: AsyncIterable<NormalizedEvent>): Promise<void> {
  for await (const _event of stream) void _event;
}

const links: LinkedDir[] = [
  { path: "/repos/frontend", label: "frontend", access: "write" },
  { path: "/repos/infra/", label: "infra", access: "read", note: "Terraform for staging" },
];

describe("claude link containment", () => {
  it("normalises trailing slashes, `.` and `..` before comparing", () => {
    expect(isUnder("/repos/infra/", "/repos/infra/main.tf")).toBe(true);
    expect(isUnder("/repos/infra", "/repos/infra")).toBe(true);
    expect(isUnder("/repos/infra", "/repos/infra/./a/../b.tf")).toBe(true);
    // a shared prefix is not containment
    expect(isUnder("/repos/infra", "/repos/infrastructure/x")).toBe(false);
    expect(isUnder("/repos/infra", "/repos/infra/../other/x")).toBe(false);
  });

  it("flags writes under a read-only link only", () => {
    expect(readOnlyLinkFor("Edit", { file_path: "/repos/infra/main.tf" }, links)?.label).toBe("infra");
    expect(readOnlyLinkFor("Write", { file_path: "/repos/infra/new.tf" }, links)?.label).toBe("infra");
    expect(readOnlyLinkFor("Edit", { file_path: "/repos/frontend/app.tsx" }, links)).toBeUndefined();
    // reads are never blocked, under either kind of link
    expect(readOnlyLinkFor("Read", { file_path: "/repos/infra/main.tf" }, links)).toBeUndefined();
    expect(readOnlyLinkFor("Grep", { path: "/repos/infra" }, links)).toBeUndefined();
    // and the thread's own cwd is untouched by any of this
    expect(readOnlyLinkFor("Edit", { file_path: "/work/repo/src/a.ts" }, links)).toBeUndefined();
  });
});

describe("ApprovalBroker with linked repos", () => {
  const broker = (): { broker: ApprovalBroker; events: NormalizedEvent[] } => {
    const events: NormalizedEvent[] = [];
    return { broker: new ApprovalBroker((event) => events.push(event), links), events };
  };
  const ctx = { toolUseID: "call-1" };

  it("denies an edit under a read-only link without ever asking the user", async () => {
    const { broker: b, events } = broker();
    const result = await b.handle("Edit", { file_path: "/repos/infra/main.tf" }, ctx);
    expect(result).toMatchObject({ behavior: "deny" });
    expect(result.behavior === "deny" && result.message).toContain("read-only linked repo");
    expect(events.every((event) => event.type !== "activity" || event.activity.kind !== "approval")).toBe(true);
  });

  it("routes an edit under a write link through the normal approval flow", async () => {
    const { broker: b, events } = broker();
    const pending = b.handle("Edit", { file_path: "/repos/frontend/app.tsx" }, ctx);
    const asked = events.find((event) => event.type === "activity" && event.activity.kind === "approval");
    expect(asked).toBeDefined();
    b.respondApproval("call-1", "accept");
    expect(await pending).toMatchObject({ behavior: "allow" });
  });
});

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("ClaudeSession additionalDirectories", () => {
  it("hands every link to the SDK so read-only links stay readable", async () => {
    const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };
    let captured: Record<string, unknown> = {};
    const queryFn: QueryFn = ({ options }) => {
      captured = options ?? {};
      return { [Symbol.asyncIterator]: async function* () {} } as unknown as ReturnType<QueryFn>;
    };
    const options: OpenSessionOptions = {
      threadId: "t1",
      cwd: "/work/repo",
      mode: "auto",
      interaction: "default",
      mcpServers: [],
      linkedDirs: links,
      systemPromptAppend: "## Linked repositories",
    };
    void collectNothing(new ClaudeSession({}, env, options, queryFn).send({ text: "hi" }));
    await tick();
    expect(captured["additionalDirectories"]).toEqual(["/repos/frontend", "/repos/infra/"]);
    expect(captured["cwd"]).toBe("/work/repo");
    expect(captured["systemPrompt"]).toMatchObject({ append: "## Linked repositories" });
  });

  it("omits additionalDirectories when the thread has no links", async () => {
    const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };
    let captured: Record<string, unknown> = {};
    const queryFn: QueryFn = ({ options }) => {
      captured = options ?? {};
      return { [Symbol.asyncIterator]: async function* () {} } as unknown as ReturnType<QueryFn>;
    };
    const options: OpenSessionOptions = { threadId: "t1", cwd: "/work/repo", mode: "auto", interaction: "default", mcpServers: [] };
    void collectNothing(new ClaudeSession({}, env, options, queryFn).send({ text: "hi" }));
    await tick();
    expect(captured["additionalDirectories"]).toBeUndefined();
  });
});
