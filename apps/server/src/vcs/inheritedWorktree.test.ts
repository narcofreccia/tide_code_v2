import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { effect, emit } from "../provider/testing/fakeDriver.ts";
import { Git } from "./git.ts";
import { GIT_TEST_ENV } from "./testing/tempRepo.ts";
import { harness, newThread, type Harness } from "./testing/vcsHarness.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** A lead, an implementer with its own worktree, and a reviewer delegated into that checkout. */
async function inherited(h: Harness): Promise<{ sourceId: string; childId: string; childTurnId: string; worktreePath: string }> {
  const lead = await newThread(h, { title: "Lead" });
  const source = await newThread(h, { useWorktree: true, title: "Impl" });
  const worktreePath = source.worktreePath ?? "";
  h.control.script(
    effect(async (options) => {
      await writeFile(join(options.cwd, "review-notes.txt"), "looks fine\n", "utf8");
    }),
    emit({ type: "settled", status: "completed" }),
  );
  const result = await h.app.engine.dispatch({ type: "thread.delegate", fromThreadId: lead.id, provider: "claude", role: "reviewer", prompt: "review", inheritWorktreeFrom: source.id });
  await h.settle();
  const created = result.events.find((r) => r.event.type === "thread.created")?.event;
  const requested = result.events.find((r) => r.event.type === "turn.requested")?.event;
  if (created?.type !== "thread.created" || requested?.type !== "turn.requested") throw new Error("expected a delegate");
  return { sourceId: source.id, childId: created.thread.id, childTurnId: requested.turn.id, worktreePath };
}

describe("inherited worktrees (R5)", () => {
  it("runs the child in the source's checkout with its own checkpoints", async () => {
    const h = await harness(cleanups);
    const f = await inherited(h);
    expect(h.control.opened.at(-1)?.cwd).toBe(f.worktreePath);
    expect(h.model().threads[f.childId]).toMatchObject({ worktreePath: f.worktreePath, branch: "tide/impl" });
    const checkpoint = h.model().turns[f.childTurnId]?.checkpoint;
    expect(checkpoint?.before).toBe(`refs/tide/checkpoints/${f.childId}/${f.childTurnId}/before`);
    expect(checkpoint?.after).toBe(`refs/tide/checkpoints/${f.childId}/${f.childTurnId}/after`);
    expect(checkpoint?.stats).toEqual({ files: 1, additions: 1, deletions: 0 });
    // no second worktree was created for the child
    const list = await new Git(h.repo.dir, { env: GIT_TEST_ENV }).run(["worktree", "list", "--porcelain"]);
    expect(list.split("\n").filter((line) => line.startsWith("worktree ")).length).toBe(2);
  });

  it("keeps the checkout while another live thread uses it, and removes it with the last one", async () => {
    const h = await harness(cleanups);
    const f = await inherited(h);

    await h.app.engine.dispatch({ type: "thread.archive", threadId: f.childId });
    await h.settle();
    expect(existsSync(f.worktreePath)).toBe(true);
    expect(existsSync(join(f.worktreePath, "review-notes.txt"))).toBe(true);
    expect(h.model().threads[f.childId]?.worktreePath).toBeUndefined();
    expect(h.model().threads[f.sourceId]?.worktreePath).toBe(f.worktreePath);

    await h.app.engine.dispatch({ type: "thread.archive", threadId: f.sourceId });
    await h.settle();
    expect(existsSync(f.worktreePath)).toBe(false);
  });

  it("archiving the source first leaves the checkout to the child", async () => {
    const h = await harness(cleanups);
    const f = await inherited(h);
    await h.app.engine.dispatch({ type: "thread.archive", threadId: f.sourceId });
    await h.settle();
    expect(existsSync(f.worktreePath)).toBe(true);
    expect(h.model().threads[f.childId]?.worktreePath).toBe(f.worktreePath);

    await h.app.engine.dispatch({ type: "worktree.detach", threadId: f.childId });
    await h.settle();
    expect(existsSync(f.worktreePath)).toBe(false);
  });

  it("refuses merge and publish from the child", async () => {
    const h = await harness(cleanups);
    const f = await inherited(h);
    await expect(h.app.engine.dispatch({ type: "thread.merge", threadId: f.childId })).rejects.toMatchObject({ code: "conflict" });
    await expect(h.app.engine.dispatch({ type: "thread.publish", threadId: f.childId })).rejects.toMatchObject({ code: "conflict" });
  });
});
