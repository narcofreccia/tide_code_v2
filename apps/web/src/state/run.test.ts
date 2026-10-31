import { afterEach, describe, expect, it, vi } from "vitest";
import { applyRunChunk, resetRun, retainRunSession, setSelectionDebounced, SELECTION_DEBOUNCE_MS, useRun, showServiceLog } from "./run.ts";
import { attachFakeStore, mockRpc, mockStream, modelWith, resetUi } from "../testHarness.ts";
import { runReconnectHandlers } from "./reconnect.ts";
import { useTerminals } from "./terminals.ts";
import { useModel } from "./model.ts";
import { emptyOwnership } from "@tide/client";
import { project, session, status } from "../components/workbench/run/fixtures.ts";

afterEach(() => {
  resetRun();
  resetUi();
  useModel.setState({ ownership: emptyOwnership() });
  vi.useRealTimers();
});

describe("applyRunChunk", () => {
  it("takes the snapshot, merges service deltas and clears on ended", () => {
    const snap = session({ "a.x": status("starting") });
    let s = applyRunChunk(undefined, { kind: "snapshot", session: snap }, "p1");
    expect(s).toBe(snap);
    s = applyRunChunk(s, { kind: "service", key: "a.x", status: status("running", { ports: { http: 8082 } }) }, "p1");
    s = applyRunChunk(s, { kind: "service", key: "a.y", status: status("failed", { reason: "exit 1" }) }, "p1");
    expect(s?.services["a.x"]?.state).toBe("running");
    expect(s?.services["a.y"]?.reason).toBe("exit 1");
    expect(snap.services["a.y"]).toBeUndefined();
    expect(applyRunChunk(s, { kind: "ended" }, "p1")).toBeUndefined();
  });

  it("starts a session from a delta that arrives before any snapshot", () => {
    const s = applyRunChunk(undefined, { kind: "service", key: "a.x", status: status("starting", { since: 7 }) }, "p1");
    expect(s).toEqual({ projectId: "p1", startedAt: 7, services: { "a.x": status("starting", { since: 7 }) } });
  });
});

describe("run session subscription", () => {
  it("subscribes once per project, releases on the last holder, resubscribes on reconnect", () => {
    const { streams } = mockStream();
    const a = retainRunSession("p1");
    const b = retainRunSession("p1");
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({ method: "run.subscribe", params: { projectId: "p1" } });
    streams[0]?.push({ kind: "snapshot", session: session({ "a.x": status("running") }) });
    expect(useRun.getState().sessions.p1?.services["a.x"]?.state).toBe("running");

    useModel.setState({ ownership: { projects: { p1: "env-1" }, threads: {} } });
    runReconnectHandlers("env-2");
    expect(streams).toHaveLength(1); // project p1 lives on env-1
    runReconnectHandlers("env-1");
    expect(streams).toHaveLength(2);
    expect(streams[0]?.cancelled).toBe(true);

    a();
    expect(streams[1]?.cancelled).toBe(false);
    b();
    expect(streams[1]?.cancelled).toBe(true);
  });
});

describe("selection", () => {
  it("shows the selection at once and saves it after the debounce, keeping pins", async () => {
    vi.useFakeTimers();
    const fake = attachFakeStore(modelWith({ projects: { p1: project({ runStack: { selected: [], pins: { "a.x.http": 9000 } } }) } }));
    setSelectionDebounced("p1", ["a.x"]);
    setSelectionDebounced("p1", ["a.x", "a.y"]);
    expect(useRun.getState().pending.p1).toEqual(["a.x", "a.y"]);
    expect(fake.dispatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SELECTION_DEBOUNCE_MS);
    expect(fake.dispatch).toHaveBeenCalledTimes(1);
    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "project.runStack.set", projectId: "p1", runStack: { selected: ["a.x", "a.y"], pins: { "a.x.http": 9000 } } }),
    );
    expect(useRun.getState().pending.p1).toBeUndefined();
    fake.detach();
  });
});

describe("showServiceLog", () => {
  it("opens the drawer on the tab labelled with the service", async () => {
    const rpc = mockRpc({
      "pty.list": () => ({ ptys: [{ ptyId: "r1", alive: true, label: "api" }, { ptyId: "r2", alive: true, label: "web" }] }),
    });
    expect(await showServiceLog("t1", "p1", "web")).toBe(true);
    expect(rpc).toHaveBeenCalledWith("pty.list", { ownerId: "run:p1" });
    expect(useTerminals.getState().drawerOpen).toBe(true);
    expect(useTerminals.getState().active.t1).toBe("r2");
  });
});
