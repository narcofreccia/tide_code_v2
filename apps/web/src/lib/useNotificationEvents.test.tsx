import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { Thread } from "@tide/contracts";
import { useModel } from "../state/model.ts";
import { resetNotifications, useNotifications } from "../state/notifications.ts";
import { useUi } from "../state/ui.ts";
import { makeThread, modelWith, resetUi } from "../testHarness.ts";
import { resetNotify } from "./notify.ts";
import { useNotificationEvents } from "./useNotificationEvents.ts";

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
});
