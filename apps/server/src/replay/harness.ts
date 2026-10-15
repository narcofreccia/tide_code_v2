import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Activity, DomainEvent, ProviderDriver, ProviderKind, ReadModel, Thread, Turn } from "@tide/contracts";
import { Replay } from "@tide/driver-testing";
import { createApp, type App } from "../app.ts";
import type { ServerConfig } from "../config.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "replay");

/** `loadReplay("codex", "turn-with-approval")` reads `test/fixtures/replay/codex/turn-with-approval.ndjson`. */
export function loadReplay(provider: string, scenario: string): Replay {
  return Replay.fromFile(join(FIXTURES, provider, `${scenario}.ndjson`));
}

export interface ReplayHarness {
  app: App;
  projectId: string;
  rootPath: string;
  events: DomainEvent[];
  model(): ReadModel;
  newThread(provider: ProviderKind, extra?: { mode?: "approval-required" | "full-access" | "auto-accept-edits" }): Promise<Thread>;
  /** `turn.request`, returns the turn id (does not wait for it to run) */
  request(threadId: string, text: string): Promise<string>;
  /** resolves once `done(model)` holds, checked now and after every event; no polling */
  until(done: (model: ReadModel) => boolean): Promise<void>;
  /** runs the whole turn: request, then drain the reactor */
  runTurn(threadId: string, text: string): Promise<Turn>;
  activities(threadId: string): Activity[];
  messages(threadId: string): { role: string; text: string }[];
  close(): Promise<void>;
}

function config(tideHome: string): ServerConfig {
  return {
    tideHome,
    dataDir: ":memory:",
    dbPath: ":memory:",
    environmentId: "env-replay",
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

/** any driver, whatever its config type (the registry stores them untyped) */
type AnyDriver = Pick<ProviderDriver<unknown>, "kind">;

/**
 * The server stack of `app.test.ts` (engine, registry, session directory, provider reactor,
 * vcs, rollback ...) with the given drivers registered: real driver code, replayed transport.
 */
export async function bootReplay(drivers: readonly AnyDriver[]): Promise<ReplayHarness> {
  const tideHome = mkdtempSync(join(tmpdir(), "tide-replay-home-"));
  const rootPath = mkdtempSync(join(tmpdir(), "tide-replay-repo-"));
  const app = await createApp({
    config: config(tideHome),
    listen: false,
    log: () => undefined,
    registerDrivers: (registry) => {
      for (const driver of drivers) registry.register(driver as unknown as ProviderDriver<Record<string, unknown>>);
    },
  });
  const events: DomainEvent[] = [];
  app.engine.subscribe((record) => void events.push(record.event));
  const project = (await app.engine.dispatch({ type: "project.create", title: "Replay", rootPath })).events[0]?.event;
  if (project?.type !== "project.created") throw new Error("expected project.created");

  const model = (): ReadModel => app.engine.getModel();
  const harness: ReplayHarness = {
    app,
    projectId: project.project.id,
    rootPath,
    events,
    model,
    async newThread(provider, extra = {}) {
      const created = (await app.engine.dispatch({ type: "thread.create", projectId: project.project.id, provider, ...extra })).events[0]?.event;
      if (created?.type !== "thread.created") throw new Error("expected thread.created");
      return created.thread;
    },
    async request(threadId, text) {
      const requested = (await app.engine.dispatch({ type: "turn.request", threadId, text })).events.map((record) => record.event).find((event) => event.type === "turn.requested");
      if (requested?.type !== "turn.requested") throw new Error("expected turn.requested");
      return requested.turn.id;
    },
    until(done) {
      return new Promise((resolve) => {
        if (done(model())) return resolve();
        const off = app.engine.subscribe(() => {
          if (!done(model())) return;
          off();
          resolve();
        });
      });
    },
    async runTurn(threadId, text) {
      const turnId = await harness.request(threadId, text);
      await app.reactor.drain();
      const turn = model().turns[turnId];
      if (!turn) throw new Error(`turn ${turnId} vanished`);
      return turn;
    },
    activities(threadId) {
      return Object.values(model().activities).filter((activity) => activity.threadId === threadId);
    },
    messages(threadId) {
      const current = model();
      return (current.threadMessages[threadId] ?? []).flatMap((id) => {
        const message = current.messages[id];
        return message ? [{ role: message.role, text: message.text }] : [];
      });
    },
    async close() {
      await app.close();
      rmSync(rootPath, { recursive: true, force: true });
      rmSync(tideHome, { recursive: true, force: true });
    },
  };
  return harness;
}
