import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { RpcFrame } from "@tide/contracts";
import { Engine } from "../orchestration/engine.ts";
import { openEventStore } from "../orchestration/store.ts";
import { createTempRepo } from "../vcs/testing/tempRepo.ts";
import { registerAttachmentHandlers } from "./attachments.ts";
import { RpcRouter } from "./router.ts";
import { threadCwdResolver } from "./workspace.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("attachments.upload", () => {
  it("writes into the thread cwd and refuses unknown threads", async () => {
    const repo = await createTempRepo("tide-att-rpc-");
    const store = await openEventStore(":memory:");
    cleanups.push(() => repo.cleanup(), () => store.close(), () => rm(repo.dir, { recursive: true, force: true }));
    const engine = new Engine({ store });
    const router = new RpcRouter();
    registerAttachmentHandlers(router, { engine, cwdFor: threadCwdResolver(engine) });
    const p = (await engine.dispatch({ type: "project.create", title: "R", rootPath: repo.dir })).events[0]?.event;
    if (p?.type !== "project.created") throw new Error("project");
    const t = (await engine.dispatch({ type: "thread.create", projectId: p.project.id, provider: "claude" })).events[0]?.event;
    if (t?.type !== "thread.created") throw new Error("thread");
    const frames: RpcFrame[] = [];
    const conn = router.connection("c", (f) => frames.push(f));
    const call = async (id: string, params: unknown): Promise<RpcFrame | undefined> => {
      await conn.handleRequest(id, "attachments.upload", params);
      return frames.find((f) => f.id === id);
    };
    const ok = await call("1", { threadId: t.thread.id, files: [{ name: "a.txt", mediaType: "text/plain", data: Buffer.from("hi").toString("base64") }] });
    expect(ok).toMatchObject({ result: { attachments: [{ name: "a.txt", bytes: 2, mediaType: "text/plain" }] } });
    expect(await call("2", { threadId: "nope", files: [{ name: "a", mediaType: "x/y", data: "" }] })).toMatchObject({ error: { code: "not-found" } });
    expect(await call("3", { threadId: t.thread.id, files: [{ name: "../a", mediaType: "x/y", data: "" }] })).toMatchObject({ error: { code: "invalid-params" } });
  });
});
