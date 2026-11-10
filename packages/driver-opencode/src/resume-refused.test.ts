import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DriverEnv, OpenSessionOptions } from "@tide/contracts";
import { FakeOpencodeApi } from "../test/fake-api.ts";
import { HttpOpencodeApi } from "./client.ts";
import { OpencodeInstance } from "./instance.ts";
import { resumeRefusal } from "./resume-refused.ts";
import type { WireSession } from "./wire.ts";

/** Recorded live: opencode 1.19.5 `GET /api/session/ses_0000000000000000000000000` (unknown id). */
const NOT_FOUND = { status: 404, body: '{"_tag":"SessionNotFoundError","sessionID":"ses_0000000000000000000000000","message":"Session not found: ses_0000000000000000000000000"}' };
/** Same run, `GET /api/session/garbage`. */
const MALFORMED = { status: 400, body: '{"_tag":"InvalidRequestError","message":"Invalid session ID","field":"sessionID"}' };

/** The error `HttpOpencodeApi.getSession` throws for a recorded answer. */
async function clientError(answer: { status: number; body: string }): Promise<unknown> {
  vi.stubGlobal("fetch", async () => ({ ok: false, status: answer.status, text: async () => answer.body }));
  try {
    await new HttpOpencodeApi({ url: "http://oc" }).getSession({ sessionId: "ses_0000000000000000000000000" });
    return undefined;
  } catch (error) {
    return error;
  }
}

class GoneSessionApi extends FakeOpencodeApi {
  readonly error: unknown;
  constructor(error: unknown) {
    super();
    this.error = error;
  }
  override async getSession(): Promise<WireSession> {
    throw this.error;
  }
}

const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };
const base: OpenSessionOptions = { threadId: "t1", cwd: "/repo", mode: "approval-required", interaction: "default", mcpServers: [] };

describe("OpenCode resume refused (R19 L5)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a resumed session the server does not know fails the open with the resume-refused code and OpenCode's words", async () => {
    const native = await clientError(NOT_FOUND);
    const instance = new OpencodeInstance({ serverUrl: "http://127.0.0.1:4096", apiImpl: new GoneSessionApi(native) }, env);
    const error = await instance.openSession({ ...base, resume: "ses_0000000000000000000000000" }).catch((e: unknown) => e);
    expect((error as Error).message).toBe("resume-refused: Session not found: ses_0000000000000000000000000");
    expect((error as Error).cause).toBe(native);
    await instance.dispose();
  });

  it("other failures stay as they were", async () => {
    const malformed = await clientError(MALFORMED);
    expect(resumeRefusal(malformed)).toBe(malformed);
    const down = new Error("fetch failed");
    expect(resumeRefusal(down)).toBe(down);
    // a fork reads its fresh copy: a 404 there is not the thread's own session going away
    const native = await clientError(NOT_FOUND);
    const api = new GoneSessionApi(native);
    const instance = new OpencodeInstance({ serverUrl: "http://127.0.0.1:4096", apiImpl: api }, env);
    expect(await instance.openSession({ ...base, forkFrom: "ses_src" }).catch((e: unknown) => e)).toBe(native);
    await instance.dispose();
  });
});
