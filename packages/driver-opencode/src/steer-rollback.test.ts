import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent, OpenSessionOptions } from "@tide/contracts";
import { FakeOpencodeApi } from "../test/fake-api.ts";
import { EventHub } from "./hub.ts";
import { OpencodeInstance } from "./instance.ts";
import { OpencodeSession } from "./session.ts";
import { turnStartsNewestFirst } from "./turns.ts";

const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };
const baseOptions: OpenSessionOptions = { threadId: "t1", cwd: "/repo", mode: "approval-required", interaction: "default", mcpServers: [] };

function harness(): { session: OpencodeSession; api: FakeOpencodeApi } {
  const api = new FakeOpencodeApi();
  const hub = new EventHub(async () => api, () => undefined);
  const session = new OpencodeSession(env, baseOptions, { api, hub, agents: { build: "build", plan: "plan" } }, api.sessionId);
  return { session, api };
}

/** flushes pending promise chains (pump → hub → mailbox → consumer); everything is in-memory */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function turn(session: OpencodeSession, api: FakeOpencodeApi, text: string): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  const done = (async () => {
    for await (const event of session.send({ text })) events.push(event);
  })();
  await flush();
  api.succeeded();
  await done;
  return events;
}

describe("OpencodeSession.steer", () => {
  it("prompts with delivery steer into the running turn, which settles once", async () => {
    const { session, api } = harness();
    const events: NormalizedEvent[] = [];
    const done = (async () => {
      for await (const event of session.send({ text: "start" })) events.push(event);
    })();
    await flush();
    await session.steer({ text: "look at b.ts instead", images: [{ mediaType: "image/png", data: "AAAA" }] });
    expect(api.prompts[1]).toEqual({ sessionId: "ses_fake", text: "look at b.ts instead", delivery: "steer", files: [{ uri: "data:image/png;base64,AAAA", name: "image-1" }] });
    api.text("msg_1", "ok");
    api.succeeded();
    await done;
    expect(events.filter((event) => event.type === "settled")).toEqual([{ type: "settled", status: "completed" }]);
    await session.close();
  });

  it("rejects without a running turn, and surfaces a server refusal", async () => {
    const { session, api } = harness();
    await expect(session.steer({ text: "late" })).rejects.toThrow(/no turn is running/);
    expect(api.prompts).toHaveLength(0);

    const done = (async () => {
      for await (const _ of session.send({ text: "start" })) void _;
    })();
    await flush();
    api.promptError = new Error("opencode POST /api/session/ses_fake/prompt failed: HTTP 409");
    await expect(session.steer({ text: "now" })).rejects.toThrow(/409/);
    api.promptError = undefined;
    api.succeeded();
    await done;
    await session.close();
  });
});

describe("OpencodeSession.rollback", () => {
  it("reverts to the user message that started the oldest dropped turn, without touching files", async () => {
    const { session, api } = harness();
    await turn(session, api, "one");
    await turn(session, api, "two");
    await turn(session, api, "three");
    await session.rollback(2);
    expect(api.reverts).toEqual([{ sessionId: "ses_fake", messageId: "msg_u3", files: false }]);
    expect(api.commits).toBe(1);
    expect(api.messageLog.map((message) => message.id)).toEqual(["msg_u1", "msg_i2"]);

    // the remaining record still lines up with the session
    await turn(session, api, "four");
    await session.rollback(2);
    expect(api.reverts.at(-1)).toMatchObject({ messageId: "msg_u1" });
    expect(api.messageLog).toEqual([]);
    await session.close();
  });

  it("counts a steered turn once", async () => {
    const { session, api } = harness();
    await turn(session, api, "one");
    const done = (async () => {
      for await (const _ of session.send({ text: "two" })) void _;
    })();
    await flush();
    await session.steer({ text: "and also" });
    api.succeeded();
    await done;
    await turn(session, api, "three");
    await session.rollback(2);
    expect(api.reverts[0]).toMatchObject({ messageId: "msg_u3" });
    await session.close();
  });

  it("reads the session for turns from before this process (resume / fork)", async () => {
    const { session, api } = harness();
    // history written by an earlier process: turn, steered turn, turn
    api.messageLog = [
      { id: "old_u1", type: "user" },
      { id: "old_a1", type: "assistant" },
      { id: "old_i1", type: "idle" },
      { id: "old_u2", type: "user" },
      { id: "old_a2", type: "assistant" },
      { id: "old_steer", type: "user" },
      { id: "old_i2", type: "idle" },
      { id: "old_u3", type: "user" },
      { id: "old_i3", type: "idle" },
    ];
    await turn(session, api, "now");
    await session.rollback(3);
    expect(api.reverts[0]).toMatchObject({ messageId: "old_u2" });
    await session.close();
  });

  it("falls back to reading the session when the server does not answer the admitted id", async () => {
    const { session, api } = harness();
    api.promptWithoutId = true;
    await turn(session, api, "one");
    await turn(session, api, "two");
    await session.rollback(1);
    expect(api.reverts[0]).toMatchObject({ messageId: "msg_u3" });
    await session.close();
  });

  it("drops a refused send without reverting, and refuses impossible requests", async () => {
    const { session, api } = harness();
    api.promptError = new Error("HTTP 400");
    const events: NormalizedEvent[] = [];
    for await (const event of session.send({ text: "bad" })) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "settled", status: "error" });
    api.promptError = undefined;
    await session.rollback(1);
    expect(api.reverts).toEqual([]);

    await turn(session, api, "one");
    await expect(session.rollback(3)).rejects.toThrow(/cannot roll back 3 turns/);
    await expect(session.rollback(-1)).rejects.toThrow(/invalid/);

    const running = (async () => {
      for await (const _ of session.send({ text: "long" })) void _;
    })();
    await flush();
    await expect(session.rollback(1)).rejects.toThrow(/busy/);
    api.succeeded();
    await running;

    api.revertError = new Error("opencode POST /revert/stage failed: HTTP 409 busy");
    await expect(session.rollback(1)).rejects.toThrow(/409/);
    expect(api.commits).toBe(0);
    await session.close();
  });

  it("pages through long histories", async () => {
    const api = new FakeOpencodeApi();
    for (let index = 0; index < 250; index++) api.messageLog.push({ id: `u${index}`, type: "user" }, { id: `i${index}`, type: "idle" });
    const starts = await turnStartsNewestFirst(api, "ses_fake", 120);
    expect(starts).toHaveLength(120);
    expect(starts[119]).toBe("u130");
    expect(await turnStartsNewestFirst(api, "ses_fake", 1000)).toHaveLength(250);
  });
});

describe("OpencodeInstance fork", () => {
  function instance(api: FakeOpencodeApi): OpencodeInstance {
    return new OpencodeInstance({ serverUrl: "http://127.0.0.1:4096", apiImpl: api }, env);
  }

  it("forks the whole history, moves the copy into the thread's worktree and applies its settings", async () => {
    const api = new FakeOpencodeApi();
    const opencode = instance(api);
    const session = await opencode.openSession({ ...baseOptions, cwd: "/repo/.tide/worktrees/t2", forkFrom: "ses_source" });
    expect(api.forks).toEqual([{ sessionId: "ses_source" }]);
    expect(session.nativeSessionId).toBe("ses_fork1");
    expect(api.moves).toEqual([{ sessionId: "ses_fork1", directory: "/repo/.tide/worktrees/t2" }]);
    expect(api.waits).toEqual(["ses_fork1"]);
    expect(api.created).toEqual([]);
    expect(api.rulesets.at(-1)?.sessionId).toBe("ses_fork1");
    await opencode.dispose();
  });

  it("skips the move when the fork already sits in the thread's directory", async () => {
    const api = new FakeOpencodeApi();
    const opencode = instance(api);
    const session = await opencode.openSession({ ...baseOptions, forkFrom: "ses_source" });
    expect(session.nativeSessionId).toBe("ses_fork1");
    expect(api.moves).toEqual([]);
    await opencode.dispose();
  });

  it("deletes the copy and fails when the move does not land", async () => {
    const api = new FakeOpencodeApi();
    api.moveLandsIn = "/repo";
    const opencode = instance(api);
    await expect(opencode.openSession({ ...baseOptions, cwd: "/elsewhere", forkFrom: "ses_source" })).rejects.toThrow(/could not move the forked session/);
    expect(api.removed).toEqual(["ses_fork1"]);
    await opencode.dispose();
  });

  it("surfaces a refused fork", async () => {
    const api = new FakeOpencodeApi();
    api.forkError = new Error("opencode POST /api/session/ses_empty/fork failed: HTTP 400 ForkEmptyError");
    const opencode = instance(api);
    await expect(opencode.openSession({ ...baseOptions, forkFrom: "ses_empty" })).rejects.toThrow(/ForkEmptyError/);
    await opencode.dispose();
  });
});
