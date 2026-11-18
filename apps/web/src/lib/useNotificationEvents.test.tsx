import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { QuotaState, Thread } from "@tide/contracts";
import { useModel } from "../state/model.ts";
import { resetNotifications, useNotifications } from "../state/notifications.ts";
import { useUi } from "../state/ui.ts";
import { makeThread, modelWith, resetUi } from "../testHarness.ts";
import { resetNotify } from "./notify.ts";
import { useNotificationEvents } from "./useNotificationEvents.ts";
import { TICK_MS } from "./useQuotaNotifications.ts";

const titles: string[] = [];

function Probe() {
  useNotificationEvents();
  return null;
}

function put(seq: number, patch: Partial<Thread> | null, status: "open" | "closed" = "open") {
  const threads = patch ? { t1: makeThread("t1", { title: "Fix", ...patch }) } : {};
  act(() => useModel.setState({ model: modelWith({ seq, threads }), status }));
}

beforeEach(() => {
  titles.length = 0;
  class FakeNotification {
    static permission = "granted";
    constructor(title: string) {
      titles.push(title);
    }
  }
  vi.stubGlobal("Notification", FakeNotification);
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  useNotifications.getState().setEnabled(true);
  put(5, { status: "idle" });
  render(<Probe />);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetNotify();
  resetNotifications();
  resetUi();
  useModel.setState({ model: modelWith({}), status: "closed" });
});

const flush = () => act(async () => undefined);

describe("notification events", () => {
  it("fires Finished once for running to idle", async () => {
    put(6, { status: "running" });
    put(7, { status: "idle" });
    await flush();
    expect(titles).toEqual(["Finished: Fix"]);
  });

  it("fires Needs you on attention, not Finished", async () => {
    put(6, { status: "running" });
    put(7, { status: "idle", attention: "approval" });
    await flush();
    expect(titles).toEqual(["Needs you: Fix"]);
  });

  it("fires Failed and Usage limit", async () => {
    put(6, { status: "running" });
    put(7, { status: "error" });
    put(8, { status: "error", limited: { resume: "manual", at: 1 } });
    await flush();
    expect(titles).toEqual(["Failed: Fix", "Usage limit: Fix"]);
  });

  it("stays quiet while focused on the selected thread", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    act(() => useUi.getState().selectThread("t1"));
    put(6, { status: "running" });
    put(7, { status: "idle" });
    await flush();
    expect(titles).toEqual([]);
  });

  it("stays quiet for muted projects", async () => {
    useNotifications.getState().toggleProjectMuted("p1");
    put(6, { status: "running" });
    put(7, { status: "idle" });
    await flush();
    expect(titles).toEqual([]);
  });

  it("treats the first model after a reconnect as a baseline", async () => {
    put(6, { status: "running" });
    put(6, { status: "running" }, "closed");
    put(9, { status: "idle" });
    await flush();
    expect(titles).toEqual([]);
  });

  it("R20: fires once when a quota warns and once when it is exceeded, per window", async () => {
    const at = (seq: number, state: QuotaState | undefined) => {
      const project = { id: "p1", title: "Side project", rootPath: "/p1", createdAt: 1, updatedAt: 1, quota: { sharePct: 30, onExceed: "hold" as const }, ...(state ? { quotaState: state } : {}) };
      act(() => useModel.setState({ model: modelWith({ seq, projects: { p1: project }, threads: { t1: makeThread("t1", { title: "Fix" }) } }), status: "open" }));
    };
    const state = (status: QuotaState["status"], usedPct: number): QuotaState => ({ status, usedPct, basis: "share", over: [], windowEndsAt: 99, at: 1 });
    at(6, state("ok", 50));
    at(7, state("warning", 81));
    at(8, undefined); // quota.set clears the state until the next measurement
    at(9, state("warning", 82));
    at(10, state("exceeded", 101));
    await flush();
    expect(titles).toEqual(["Side project is at 81% of its quota", "Side project reached its quota"]);
  });

  it("R20: fires once when a manual thread's limit resets, which no event announces", async () => {
    cleanup();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const resetsAt = Date.now() + 10_000;
      put(5, { limited: { resume: "manual", resetsAt, at: 1 } });
      render(<Probe />);
      put(6, { limited: { resume: "manual", resetsAt, at: 1 } });
      await flush();
      expect(titles).toEqual([]);
      act(() => vi.advanceTimersByTime(TICK_MS));
      act(() => vi.advanceTimersByTime(TICK_MS));
      await flush();
      expect(titles).toEqual(["Limit reset: Fix"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
