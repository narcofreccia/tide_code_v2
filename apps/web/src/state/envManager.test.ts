import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyReadModel, type ClientCommand, type ReadModel } from "@tide/contracts";
import { installFakeConnections } from "./fakeEnvConnection.ts";
import { resetEnvManager, setFrameScheduler, startEnvironments } from "./envManager.ts";
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
