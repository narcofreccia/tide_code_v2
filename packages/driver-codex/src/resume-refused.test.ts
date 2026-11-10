import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DriverEnv, OpenSessionOptions } from "@tide/contracts";
import { fakeSpawn } from "./fake-app-server.ts";
import { JsonRpcError } from "./jsonrpc.ts";
import { resumeRefusal } from "./resume-refused.ts";
import { CodexSession } from "./session.ts";

/** Recorded live: codex-cli 0.166.0 `thread/resume` of an id with no rollout (empty CODEX_HOME). */
const NO_ROLLOUT = "no rollout found for thread id 019a0000-0000-7000-8000-000000000001";
/** Same run, an id that is not a uuid: not a refusal of a session Codex once had. */
const MALFORMED = "invalid session id: invalid character: expected an optional prefix of `urn:uuid:` followed by [0-9a-fA-F-], found `n` at 1";

const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };
const base: OpenSessionOptions = { threadId: "t1", cwd: "/tmp/repo", mode: "approval-required", interaction: "default", mcpServers: [] };

async function open(overrides: Partial<OpenSessionOptions>, failing: Record<string, string>): Promise<unknown> {
  const { spawn } = fakeSpawn((server) => {
    for (const [method, message] of Object.entries(failing)) server.failMethods.set(method, message);
  });
  try {
    await CodexSession.open({ spawnImpl: spawn, networkAccess: false, tomlReader: () => undefined }, env, { ...base, ...overrides }, "/usr/bin/codex");
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("Codex resume refused (R19 L5)", () => {
  it("a thread/resume answered 'no rollout found' fails the open with the resume-refused code and Codex's words", async () => {
    const error = await open({ resume: "019a0000-0000-7000-8000-000000000001" }, { "thread/resume": NO_ROLLOUT });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`resume-refused: ${NO_ROLLOUT}`);
    expect((error as Error).cause).toBeInstanceOf(JsonRpcError);
  });

  it("other failures stay as they were", async () => {
    expect(((await open({ resume: "not-a-uuid" }, { "thread/resume": MALFORMED })) as Error).message).toBe(MALFORMED);
    // a fork whose source is gone is not this thread's session
    expect(((await open({ forkFrom: "019a0000-0000-7000-8000-000000000001" }, { "thread/fork": NO_ROLLOUT })) as Error).message).toBe(NO_ROLLOUT);
    expect(resumeRefusal(new Error(NO_ROLLOUT))).toEqual(new Error(NO_ROLLOUT)); // not a JSON-RPC answer
  });
});
