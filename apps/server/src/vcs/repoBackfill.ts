import type { EventRecord } from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import { detectRepoIdentity } from "./repoIdentity.ts";

export interface RepoBackfillOptions {
  engine: Engine;
  log?: (msg: string, data?: unknown) => void;
}

/**
 * Fills `Project.repo` for projects created before R17 or whose root gained an `origin` later.
 * Dispatches `project.update`; projects that already have a repo are skipped, so a restart
 * re-detects nothing it already knows.
 */
export class RepoBackfill {
  #engine: Engine;
  #log: (msg: string, data?: unknown) => void;
  #inflight = new Set<Promise<unknown>>();
  #unsubscribe: (() => void) | undefined;

  constructor(options: RepoBackfillOptions) {
    this.#engine = options.engine;
    this.#log = options.log ?? ((msg, data) => (data === undefined ? console.error(msg) : console.error(msg, data)));
  }

  /** Subscribes, then sweeps the projects that are already in the model. */
  start(): void {
    this.#unsubscribe ??= this.#engine.subscribe((record) => this.#onRecord(record));
    for (const project of Object.values(this.#engine.getModel().projects)) this.#track(this.#fill(project.id));
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  async drain(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
    await this.#engine.drain();
  }

  #onRecord(record: EventRecord): void {
    const event = record.event;
    if (event.type === "project.created") {
      if (event.project.repo === undefined) this.#track(this.#fill(event.project.id));
    } else if (event.type === "project.unarchived") this.#track(this.#fill(event.projectId));
  }

  async #fill(projectId: string): Promise<void> {
    try {
      const project = this.#engine.getModel().projects[projectId];
      if (project === undefined || project.repo !== undefined) return;
      const repo = await detectRepoIdentity(project.rootPath);
      if (repo === undefined) return;
      // the project may have been filled (or removed) while git ran
      if (this.#engine.getModel().projects[projectId]?.repo !== undefined) return;
      await this.#engine.dispatch({ type: "project.update", projectId, repo });
    } catch (err) {
      this.#log(`[repo-backfill] ${projectId} failed`, err);
    }
  }

  #track(promise: Promise<unknown>): void {
    const tracked = promise.finally(() => this.#inflight.delete(tracked));
    this.#inflight.add(tracked);
  }
}
