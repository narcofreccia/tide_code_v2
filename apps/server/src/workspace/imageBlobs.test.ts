import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { createImageBlobs } from "./imageBlobs.ts";

const dirs: string[] = [];
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "tide-blobs-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PNG = { mediaType: "image/png", data: Buffer.from("not really a png").toString("base64") };

describe("image blobs (R24)", () => {
  it("stores each content once and loads it back; inline images pass through", () => {
    const blobs = createImageBlobs(join(scratch(), "images"));
    const [a] = blobs.stash([PNG]);
    const [b] = blobs.stash([PNG]);
    expect(a).toEqual(b);
    expect(a && "blob" in a ? a.blob : "").toMatch(/^[0-9a-f]{64}$/);
    expect(blobs.load([a!, PNG])).toEqual([PNG, PNG]);
  });

  it("drops a missing blob instead of failing", () => {
    const logs: string[] = [];
    const blobs = createImageBlobs(join(scratch(), "images"), (m) => logs.push(m));
    expect(blobs.load([{ mediaType: "image/png", blob: "0".repeat(64) }])).toEqual([]);
    expect(logs[0]).toContain("missing");
  });

  it("the engine records a reference, not the bytes", async () => {
    const dir = join(scratch(), "images");
    const store = new EventStore(await openDatabase(":memory:"));
    const engine = new Engine({ store, imageBlobs: createImageBlobs(dir) });
    const project = (await engine.dispatch({ type: "project.create", title: "P", rootPath: "/repo" })).events[0]?.event;
    if (project?.type !== "project.created") throw new Error("expected project");
    const created = (await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude" })).events[0]?.event;
    if (created?.type !== "thread.created") throw new Error("expected thread");
    const result = await engine.dispatch({ type: "turn.request", threadId: created.thread.id, text: "look", images: [PNG] });
    const requested = result.events.find((r) => r.event.type === "turn.requested")?.event;
    if (requested?.type !== "turn.requested") throw new Error("expected turn.requested");
    expect(requested.images).toEqual([{ mediaType: "image/png", blob: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(JSON.stringify(store.readAll())).not.toContain(PNG.data);
    expect(readdirSync(dir)).toHaveLength(1);
  });
});
