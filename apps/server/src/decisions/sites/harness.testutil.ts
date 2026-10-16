import { Engine } from "../../orchestration/engine.ts";
import { EventStore } from "../../orchestration/store.ts";
import { openDatabase } from "../../db/sqlite.ts";

export async function memoryEngine(): Promise<Engine> {
  return new Engine({ store: new EventStore(await openDatabase(":memory:")), now: () => 1_000 });
}

export async function seedProject(engine: Engine): Promise<string> {
  const r = await engine.dispatch({ type: "project.create", title: "P", rootPath: "/repo" });
  const e = r.events[0]?.event;
  if (e?.type !== "project.created") throw new Error("expected project");
  return e.project.id;
}
