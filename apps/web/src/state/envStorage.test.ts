import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyOwnership } from "@tide/client";
import { LAST_SEEN_KEY } from "./lastSeen.ts";
import { WORKBENCH_STORAGE_KEY } from "./workbench.ts";
import { DRAFTS_STORAGE_KEY } from "./drafts.ts";
import { useEnvironments } from "./envStore.ts";
import {
  SCOPED_SPECS,
  migrateEnvStorage,
  purgeEnvStorage,
  readScoped,
  renameEnvStorage,
  resetEnvStorage,
  writeScoped,
} from "./envStorage.ts";
import { useModel } from "./model.ts";

const get = (key: string): unknown => JSON.parse(window.localStorage.getItem(key) ?? "null");

beforeEach(() => {
  window.localStorage.clear();
  resetEnvStorage();
  useEnvironments.setState({
    environments: [
      { id: "env-L", name: "", routes: [{ kind: "local", url: "ws://127.0.0.1:3777/ws", priority: 0 }], addedAt: 0 },
      { id: "env-R", name: "r", routes: [{ kind: "lan", url: "ws://10.0.0.2:3777/ws", priority: 10 }], addedAt: 0 },
    ],
    statuses: {},
    primaryId: "env-L",
  });
  useModel.setState({ ownership: { projects: { pR: "env-R" }, threads: { tR: "env-R", tL: "env-L" } } });
});
afterEach(() => {
  useEnvironments.setState({ environments: [], statuses: {}, primaryId: undefined });
  useModel.setState({ ownership: emptyOwnership() });
});

describe("per-environment storage", () => {
  it("covers the stores' real keys", () => {
    expect(Object.keys(SCOPED_SPECS).sort()).toEqual([DRAFTS_STORAGE_KEY, LAST_SEEN_KEY, WORKBENCH_STORAGE_KEY].sort());
  });

  it("migrates the legacy single-server values under the local environment", () => {
    window.localStorage.setItem(LAST_SEEN_KEY, JSON.stringify({ since: 7, seen: { t1: 2, t2: 3 } }));
    window.localStorage.setItem(WORKBENCH_STORAGE_KEY, JSON.stringify({ state: { tabs: { t1: [{ kind: "changes" }] }, active: { t1: "changes" }, treeVisible: true }, version: 0 }));
    window.localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify({ drafts: { t1: { text: "hi", updatedAt: 1, images: 0 } }, stash: [{ id: "s", text: "x", updatedAt: 1, images: 0 }] }));
    migrateEnvStorage("env-L");

    expect(get(LAST_SEEN_KEY)).toEqual({ since: 7, seen: {} });
    expect(get(`${LAST_SEEN_KEY}@env-L`)).toEqual({ seen: { t1: 2, t2: 3 } });
    expect(get(WORKBENCH_STORAGE_KEY)).toEqual({ state: { tabs: {}, active: {}, treeVisible: true }, version: 0 });
    expect(get(`${WORKBENCH_STORAGE_KEY}@env-L`)).toEqual({ tabs: { t1: [{ kind: "changes" }] }, active: { t1: "changes" } });
    expect((get(DRAFTS_STORAGE_KEY) as { stash: unknown[] }).stash).toHaveLength(1);
    expect(get(`${DRAFTS_STORAGE_KEY}@env-L`)).toEqual({ drafts: { t1: { text: "hi", updatedAt: 1, images: 0 } } });

    // reading merges everything back: the stores never see the split
    expect(JSON.parse(readScoped(LAST_SEEN_KEY)!)).toEqual({ since: 7, seen: { t1: 2, t2: 3 } });
    // idempotent
    migrateEnvStorage("env-L");
    expect(get(`${LAST_SEEN_KEY}@env-L`)).toEqual({ seen: { t1: 2, t2: 3 } });
  });

  it("writes each thread's entry under its owner, unknown ones where they were read from", () => {
    window.localStorage.setItem(`${LAST_SEEN_KEY}@env-R`, JSON.stringify({ seen: { old: 1 } }));
    readScoped(LAST_SEEN_KEY);
    writeScoped(LAST_SEEN_KEY, JSON.stringify({ since: 1, seen: { tR: 4, tL: 2, old: 1, fresh: 9 } }));
    expect(get(`${LAST_SEEN_KEY}@env-R`)).toEqual({ seen: { tR: 4, old: 1 } });
    // unknown owner and never read: the primary's bucket
    expect(get(`${LAST_SEEN_KEY}@env-L`)).toEqual({ seen: { tL: 2, fresh: 9 } });
    expect(get(LAST_SEEN_KEY)).toEqual({ since: 1, seen: {} });
  });

  it("scopes `new:<projectId>` draft keys by project", () => {
    writeScoped(DRAFTS_STORAGE_KEY, JSON.stringify({ drafts: { "new:pR": { text: "a", updatedAt: 1, images: 0 } }, stash: [] }));
    expect(get(`${DRAFTS_STORAGE_KEY}@env-R`)).toEqual({ drafts: { "new:pR": { text: "a", updatedAt: 1, images: 0 } } });
  });

  it("purges a removed environment and renames a provisional one", () => {
    writeScoped(LAST_SEEN_KEY, JSON.stringify({ since: 1, seen: { tR: 4, tL: 2 } }));
    purgeEnvStorage("env-R");
    expect(window.localStorage.getItem(`${LAST_SEEN_KEY}@env-R`)).toBeNull();
    renameEnvStorage("env-L", "env-9");
    expect(window.localStorage.getItem(`${LAST_SEEN_KEY}@env-L`)).toBeNull();
    expect(get(`${LAST_SEEN_KEY}@env-9`)).toEqual({ seen: { tL: 2 } });
  });

  it("writes the legacy single blob while no environment is known", () => {
    useEnvironments.setState({ environments: [], primaryId: undefined });
    writeScoped(LAST_SEEN_KEY, JSON.stringify({ since: 1, seen: { t1: 1 } }));
    expect(get(LAST_SEEN_KEY)).toEqual({ since: 1, seen: { t1: 1 } });
  });
});
