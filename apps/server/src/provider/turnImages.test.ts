import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyReadModel, type DriverCaps, type ReadModel, type TurnInput } from "@tide/contracts";
import { eventOf, run } from "../orchestration/decider/r4.fixtures.ts";
import { steerImages, turnImages, type TurnImagesDeps } from "./turnImages.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const image = { mediaType: "image/png", data: PNG.toString("base64") };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "tide-turnimg-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A thread in a project rooted at `root`, with one turn requested carrying an image. */
function fixture(root: string): { model: ReadModel; threadId: string; turnId: string; path: string } {
  const project = run(emptyReadModel(), { type: "project.create", title: "T", rootPath: root });
  const projectId = eventOf(project.events, "project.created").project.id;
  const thread = run(project.model, { type: "thread.create", projectId, provider: "claude" });
  const threadId = eventOf(thread.events, "thread.created").thread.id;
  const turn = run(thread.model, { type: "turn.request", threadId, text: "look", images: [image] });
  const requested = eventOf(turn.events, "turn.requested");
  return { model: turn.model, threadId, turnId: requested.turn.id, path: requested.userMessage.attachments?.[0]?.path as string };
}

function deps(model: ReadModel, caps: Partial<DriverCaps>): TurnImagesDeps & { logs: string[] } {
  const logs: string[] = [];
  return { engine: { getModel: () => model }, sessions: { caps: async () => caps }, log: (msg) => void logs.push(msg), logs };
}

const input: TurnInput = { text: "look", images: [image] };

describe("turnImages (R22)", () => {
  it("saves the copy in the thread's checkout and keeps the pixels for a harness that takes images", async () => {
    const root = await tempDir();
    const f = fixture(root);
    const d = deps(f.model, { images: true });
    const thread = f.model.threads[f.threadId]!;
    const out = await turnImages(d, thread, f.model.projects[thread.projectId]!, f.turnId, input);
    expect(out).toEqual(input);
    expect(await readFile(join(root, f.path))).toEqual(PNG);
  });

  it("drops the pixels when the harness does not take images, so the saved path is the route", async () => {
    const root = await tempDir();
    const f = fixture(root);
    const thread = f.model.threads[f.threadId]!;
    const out = await turnImages(deps(f.model, { images: false }), thread, f.model.projects[thread.projectId]!, f.turnId, input);
    expect(out).toEqual({ text: "look" });
    expect(await readFile(join(root, f.path))).toEqual(PNG);
  });

  it("a failed write is logged and the turn keeps its pixels", async () => {
    const root = await tempDir();
    // a plain file where the `.tide` directory should go makes the mkdir fail
    await writeFile(join(root, ".tide"), "in the way");
    const f = fixture(root);
    const d = deps(f.model, { images: false });
    const thread = f.model.threads[f.threadId]!;
    const out = await turnImages(d, thread, f.model.projects[thread.projectId]!, f.turnId, input);
    expect(out).toEqual(input);
    expect(d.logs.join("\n")).toContain("could not save");
  });

  it("leaves a turn without inline images alone", async () => {
    const root = await tempDir();
    const f = fixture(root);
    const plain = run(f.model, { type: "turn.request", threadId: f.threadId, text: "no images" });
    const turnId = eventOf(plain.events, "turn.requested").turn.id;
    const thread = plain.model.threads[f.threadId]!;
    const text: TurnInput = { text: "no images" };
    expect(await turnImages(deps(plain.model, { images: false }), thread, plain.model.projects[thread.projectId]!, turnId, text)).toBe(text);
  });

  it("saves a steer's images from its message", async () => {
    const root = await tempDir();
    const f = fixture(root);
    const started = run(f.model, { type: "turn.start", turnId: f.turnId, provider: "claude" });
    const steer = run(started.model, { type: "turn.steer", threadId: f.threadId, text: "and this", images: [image] });
    const message = eventOf(steer.events, "turn.steered").message;
    const out = await steerImages(deps(steer.model, { images: true }), f.threadId, message.id, { text: "and this", images: [image] });
    expect(out.images).toEqual([image]);
    expect(await readFile(join(root, message.attachments?.[0]?.path as string))).toEqual(PNG);
  });
});
