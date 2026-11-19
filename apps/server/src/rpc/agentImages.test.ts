import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DomainEvent, EventOf, RpcOutput } from "@tide/contracts";
import { createApp, type App } from "../app.ts";
import type { ServerConfig } from "../config.ts";
import { createFakeDriver, type FakeDriverControl } from "../provider/testing/fakeDriver.ts";
import { WsTestClient } from "./testing/wsClient.ts";

// R22: agents hand images to other threads by path; the server reads them from the caller's checkout.

const TOKEN = "agent-images-token";
const config: ServerConfig = {
  tideHome: "/tmp/tide-agent-images-test",
  dataDir: ":memory:",
  dbPath: ":memory:",
  environmentId: "env-agent-images",
  token: TOKEN,
  host: "127.0.0.1",
  port: 0,
  dev: true,
  printToken: false,
  corsOrigins: [],
  version: "0.0.0-test",
  providers: {},
};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const pixels = { mediaType: "image/png", data: PNG.toString("base64") };

let app: App;
let control: FakeDriverControl;
let agent: WsTestClient;
let root: string;
let projectId: string;
let caller: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "tide-agent-images-")));
  await writeFile(join(root, "shot.png"), PNG);
  await writeFile(join(root, "notes.png"), "not an image");
  const fake = createFakeDriver("claude");
  control = fake.control;
  app = await createApp({ config, log: () => undefined, registerDrivers: (registry) => registry.register(fake.driver) });
  const project = (await app.engine.dispatch({ type: "project.create", title: "T", rootPath: root })).events[0]?.event;
  if (project?.type !== "project.created") throw new Error("expected project.created");
  projectId = project.project.id;
  const created = (await app.engine.dispatch({ type: "thread.create", projectId, provider: "claude", title: "Caller", mode: "auto-accept-edits" })).events[0]?.event;
  if (created?.type !== "thread.created") throw new Error("expected thread.created");
  caller = created.thread.id;
  agent = await WsTestClient.open(`${app.server?.url ?? ""}?agentToken=${app.agentTokens.getOrCreate(caller)}`);
});

afterAll(async () => {
  agent.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
});

function requestedOf(result: RpcOutput<"agent.dispatch">): EventOf<"turn.requested"> {
  const found = result.events.map((r) => r.event).find((e: DomainEvent) => e.type === "turn.requested");
  if (found?.type !== "turn.requested") throw new Error("expected turn.requested");
  return found;
}

const delegate = { type: "thread.delegate", fromThreadId: "self", provider: "claude", prompt: "look at this", useWorktree: false } as const;

describe("agent.dispatch imagePaths (R22)", () => {
  it("reads the caller's image into the child's first turn; the child saves its own copy", async () => {
    const result = await agent.call<RpcOutput<"agent.dispatch">>("agent.dispatch", { command: delegate, imagePaths: ["shot.png"] });
    const requested = requestedOf(result);
    expect(requested.images).toEqual([pixels]);
    const path = requested.userMessage.attachments?.[0]?.path as string;
    expect(path).toBe(`.tide/attachments/${requested.userMessage.id}/image-1.png`);
    await app.reactor.drain();
    expect(await readFile(join(root, path))).toEqual(PNG);
    // the fake harness does not take images: the path in the footer is its route
    const input = control.sessionFor(requested.turn.threadId)?.inputs[0];
    expect(input?.images).toBeUndefined();
    expect(input?.text).toContain(path);
  });

  it("ignores image bytes sent on the command itself", async () => {
    const requested = requestedOf(await agent.call<RpcOutput<"agent.dispatch">>("agent.dispatch", { command: { ...delegate, images: [pixels] } }));
    expect(requested.images).toBeUndefined();
    await app.reactor.drain();
  });

  it("refuses imagePaths with any other command, and paths that are not images in the checkout", async () => {
    const other = await agent.expectError("agent.dispatch", { command: { type: "task.delete", taskId: "nope" }, imagePaths: ["shot.png"] });
    expect(other).toMatchObject({ code: "invalid-params", message: expect.stringContaining("thread.delegate") });
    expect(await agent.expectError("agent.dispatch", { command: delegate, imagePaths: ["notes.png"] })).toMatchObject({ code: "invalid-params", message: expect.stringContaining("notes.png") });
    expect(await agent.expectError("agent.dispatch", { command: delegate, imagePaths: ["/etc/hosts"] })).toMatchObject({ code: "invalid-params", message: expect.stringContaining("outside") });
  });
});

describe("agent.thread.send imagePaths (R22)", () => {
  it("starts the target's turn with the images", async () => {
    const created = (await app.engine.dispatch({ type: "thread.create", projectId, provider: "claude", title: "Target", mode: "approval-required" })).events[0]?.event;
    if (created?.type !== "thread.created") throw new Error("expected thread.created");
    const sent = await agent.call<RpcOutput<"agent.thread.send">>("agent.thread.send", { threadId: created.thread.id, text: "see the screenshot", imagePaths: ["shot.png"] });
    expect(sent.delivered).toBe("started");
    const message = app.engine.getModel().messages[sent.messageId as string];
    expect(message?.attachments).toEqual([{ mediaType: "image/png", bytes: expect.any(Number), name: "image-1.png", path: `.tide/attachments/${sent.messageId}/image-1.png`, inline: true }]);
    await app.reactor.drain();
    expect(await readFile(join(root, `.tide/attachments/${sent.messageId}/image-1.png`))).toEqual(PNG);
    expect(await agent.expectError("agent.thread.send", { threadId: created.thread.id, text: "x", imagePaths: ["missing.png"] })).toMatchObject({ code: "invalid-params" });
  });
});
