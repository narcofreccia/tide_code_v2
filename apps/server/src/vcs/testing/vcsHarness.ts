import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Activity, ReadModel, Thread } from "@tide/contracts";
import { createApp, type App } from "../../app.ts";
import type { ServerConfig } from "../../config.ts";
import { createFakeDriver, type FakeDriverControl } from "../../provider/testing/fakeDriver.ts";
import type { GhLike, PrCreateInput, PrMergeInput, PrRef } from "../gh.ts";
import { createTempRepo, type TempRepo } from "./tempRepo.ts";

/** Scripted `gh`: records calls, answers from what the test set up. */
export class FakeGh implements GhLike {
  available = true;
  existing: PrRef | undefined;
  created: { cwd: string; input: PrCreateInput }[] = [];
  viewed: string[] = [];
  merged: { cwd: string; number: number; input: PrMergeInput }[] = [];
  /** state `prView` reports for a PR number once `prMerge` ran */
  stateAfterMerge: PrRef["state"] = "merged";
  async hasGh(): Promise<boolean> {
    return this.available;
  }
  async prCreate(cwd: string, input: PrCreateInput): Promise<{ url: string; number: number }> {
    this.created.push({ cwd, input });
    return { url: "https://github.com/acme/repo/pull/42", number: 42 };
  }
  async prView(_cwd: string, branch: string): Promise<PrRef | undefined> {
    this.viewed.push(branch);
    const merged = this.merged.find((m) => String(m.number) === branch && m.input.auto !== true);
    if (merged !== undefined) return { url: `https://github.com/acme/repo/pull/${merged.number}`, number: merged.number, state: this.stateAfterMerge };
    return this.existing;
  }
  async prMerge(cwd: string, number: number, input: PrMergeInput): Promise<void> {
    this.merged.push({ cwd, number, input });
  }
}

export function baseConfig(tideHome: string): ServerConfig {
  return {
    tideHome,
    dataDir: ":memory:",
    dbPath: ":memory:",
    environmentId: "env-vcs",
    token: "t",
    host: "127.0.0.1",
    port: 0,
    dev: true,
    printToken: false,
    corsOrigins: [],
    version: "0.0.0-test",
    providers: {},
  };
}

export interface Harness {
  app: App;
  repo: TempRepo;
  tideHome: string;
  control: FakeDriverControl;
  gh: FakeGh;
  projectId: string;
  model(): ReadModel;
  settle(): Promise<void>;
}

/** An in-memory app over a real temp repo; teardown is pushed onto `cleanups`. */
export async function harness(cleanups: (() => Promise<void>)[]): Promise<Harness> {
  const repo = await createTempRepo("tide-reactor-");
  const tideHome = await mkdtemp(join(tmpdir(), "tide-home-"));
  const { driver, control } = createFakeDriver("claude");
  const gh = new FakeGh();
  const app = await createApp({
    config: baseConfig(tideHome),
    listen: false,
    log: () => undefined,
    gh,
    registerDrivers: (registry) => registry.register(driver),
  });
  cleanups.push(() => app.close(), () => repo.cleanup(), () => rm(tideHome, { recursive: true, force: true }));

  const created = (await app.engine.dispatch({ type: "project.create", title: "Repo", rootPath: repo.dir })).events[0]?.event;
  if (created?.type !== "project.created") throw new Error("expected project.created");

  // Both reactors feed the engine, and the provider reactor waits on the vcs one, so a
  // settled state needs a second pass over each — never a sleep.
  const settle = async (): Promise<void> => {
    await app.reactor.drain();
    await app.vcs.drain();
    await app.engine.drain();
    await app.reactor.drain();
    await app.vcs.drain();
  };
  return { app, repo, tideHome, control, gh, projectId: created.project.id, model: () => app.engine.getModel(), settle };
}

export async function newThread(h: Harness, options: { useWorktree?: boolean; title?: string } = {}): Promise<Thread> {
  const created = (
    await h.app.engine.dispatch({
      type: "thread.create",
      projectId: h.projectId,
      provider: "claude",
      title: options.title ?? "Do the thing",
      ...(options.useWorktree === true ? { useWorktree: true } : {}),
    })
  ).events[0]?.event;
  if (created?.type !== "thread.created") throw new Error("expected thread.created");
  await h.settle();
  const thread = h.model().threads[created.thread.id];
  if (!thread) throw new Error("thread vanished");
  return thread;
}

export async function requestTurn(h: Harness, threadId: string, text: string): Promise<string> {
  const requested = (await h.app.engine.dispatch({ type: "turn.request", threadId, text })).events[0]?.event;
  if (requested?.type !== "turn.requested") throw new Error("expected turn.requested");
  await h.settle();
  return requested.turn.id;
}

export const activitiesOf = (model: ReadModel, threadId: string): Activity[] =>
  Object.values(model.activities).filter((a) => a.threadId === threadId);
