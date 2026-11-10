import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyReadModel, type ClientCommand, type ReadModel } from "@tide/contracts";
import { installFakeConnections } from "./fakeEnvConnection.ts";
import { isLocalEnv, resetEnvManager, setFrameScheduler, startEnvironments } from "./envManager.ts";
import { useEnvironments } from "./envStore.ts";
import { saveEnvironments } from "./envPersist.ts";
import { dispatch, useModel } from "./model.ts";
import { resetProviders } from "./providers.ts";
import { resetServerSettings } from "./serverSettings.ts";

/** A hand-stepped frame clock. */
function fakeFrames(): { schedule: (cb: () => void) => void; frame: () => void } {
  let queue: (() => void)[] = [];
  return {
    schedule: (cb) => {
      queue.push(cb);
    },
    frame: () => {
      const run = queue;
      queue = [];
      for (const cb of run) cb();
    },
  };
}

function modelAt(seq: number): ReadModel {
  const m = emptyReadModel();
  m.seq = seq;
  m.projects[`p${seq}`] = { id: `p${seq}`, title: `p${seq}`, rootPath: `/p${seq}`, createdAt: 1, updatedAt: 1 };
  return m;
}

let fakes: ReturnType<typeof installFakeConnections>;
let frames: ReturnType<typeof fakeFrames>;
let publishes: number[];
let off: () => void;

beforeEach(() => {
  window.localStorage.clear();
  resetEnvManager();
  resetProviders();
  resetServerSettings();
  fakes = installFakeConnections();
  frames = fakeFrames();
  setFrameScheduler(frames.schedule);
  startEnvironments({ url: "ws://127.0.0.1:3777/ws", token: "tok" });
  frames.frame();
  publishes = [];
  off = useModel.subscribe((s, prev) => {
    if (s.model !== prev.model) publishes.push(s.model.seq);
  });
});

afterEach(() => {
  off();
  resetEnvManager();
});

describe("envManager frame batching", () => {
  it("merges ten store updates in one frame into one useModel publish with the last model", () => {
    const local = fakes.byId("local");
    for (let seq = 1; seq <= 10; seq++) local.setModel(modelAt(seq));
    expect(publishes).toEqual([]);
    frames.frame();
    expect(publishes).toEqual([10]);
    expect(Object.keys(useModel.getState().model.projects)).toEqual(["p10"]);
    frames.frame();
    expect(publishes).toEqual([10]);
  });

  it("a dispatch result flushes the merged model without waiting for the frame", async () => {
    const local = fakes.byId("local");
    local.setModel(modelAt(3));
    expect(publishes).toEqual([]);
    const command = { type: "project.create", title: "x", rootPath: "/x", requestId: "r1" } as unknown as ClientCommand;
    await dispatch(command);
    expect(local.dispatched).toHaveLength(1);
    expect(publishes).toEqual([3]);
    frames.frame();
    expect(publishes).toEqual([3]);
  });
});

describe("envManager ready", () => {
  it("turns ready with the primary's first snapshot, in the same publish as its model, and stays ready", () => {
    const local = fakes.byId("local");
    // the fake store does not track `ready`; make it a real "not loaded yet" store
    Object.assign(local.store.getState(), { ready: false });
    useModel.setState({ ready: false });
    local.setModel(modelAt(1));
    frames.frame();
    expect(useModel.getState().ready).toBe(false);
    const seen: [boolean, number][] = [];
    const offReady = useModel.subscribe((s) => seen.push([s.ready, s.model.seq]));
    Object.assign(local.store.getState(), { ready: true });
    local.setModel(modelAt(2));
    frames.frame();
    offReady();
    expect(seen).toEqual([[true, 2]]);
    Object.assign(local.store.getState(), { ready: false });
    local.setModel(modelAt(3));
    frames.frame();
    expect(useModel.getState().ready).toBe(true);
  });
});

describe("envManager remote launch", () => {
  const REMOTE = "ws://10.0.0.5:3777/ws";

  it("synthesises no local route and makes the other machine the primary", () => {
    window.localStorage.clear();
    startEnvironments({ url: REMOTE, token: "dev-tok", clientId: "c1", remote: true });
    const { environments, primaryId } = useEnvironments.getState();
    expect(environments).toHaveLength(1);
    const env = environments[0]!;
    expect(env.routes).toEqual([{ kind: "lan", url: REMOTE, priority: 10 }]);
    expect(env).toMatchObject({ token: "dev-tok", clientId: "c1" });
    expect(isLocalEnv(env)).toBe(false);
    expect(primaryId).toBe(env.id);
    expect(environments.some((e) => e.id === "local")).toBe(false);

    // whoever answers on the route is adopted under its real id
    const conn = fakes.byId(env.id);
    expect(conn.opts.verifyId).toBe(false);
    conn.emit({ state: "connected", environmentId: "env-box" });
    expect(useEnvironments.getState().primaryId).toBe("env-box");
    expect(useEnvironments.getState().environments.map((e) => e.id)).toEqual(["env-box"]);
    expect(useModel.getState().environmentId).toBe("env-box");
  });

  it("reuses a known machine with the new token and keeps the local one as a non-primary", () => {
    saveEnvironments({
      environments: [
        { id: "env-local", name: "laptop", routes: [{ kind: "local", url: "ws://127.0.0.1:5000/ws", priority: 0 }], addedAt: 1, token: "master" },
        { id: "env-box", name: "box", routes: [{ kind: "lan", url: REMOTE, priority: 10 }], addedAt: 2, token: "old", clientId: "c-old" },
      ],
      primaryId: "env-local",
      ownership: { projects: {}, threads: {} },
    });
    startEnvironments({ url: REMOTE, token: "new", remote: true });
    const { environments, primaryId } = useEnvironments.getState();
    expect(primaryId).toBe("env-box");
    expect(environments.map((e) => e.id)).toEqual(["env-local", "env-box"]);
    const box = environments.find((e) => e.id === "env-box")!;
    expect(box.token).toBe("new");
    expect(box.clientId).toBeUndefined();
    expect(fakes.byId("env-box").opts.verifyId).toBe(true);
    // a reload (hand-off consumed) restores the list as it was saved
    startEnvironments({ url: "", token: "", remote: true });
    expect(useEnvironments.getState().primaryId).toBe("env-box");
    expect(useEnvironments.getState().environments.find((e) => e.id === "env-local")!.routes[0]!.url).toBe("ws://127.0.0.1:5000/ws");
  });
});
