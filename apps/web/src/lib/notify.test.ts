import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notify, resetNotify } from "./notify.ts";
import { resetNotifications, useNotifications } from "../state/notifications.ts";
import { useUi } from "../state/ui.ts";

const created: { title: string; opts: NotificationOptions; onclick?: () => void; close: () => void }[] = [];

beforeEach(() => {
  created.length = 0;
  class FakeNotification {
    static permission = "granted";
    onclick?: () => void;
    close = vi.fn();
    constructor(title: string, opts: NotificationOptions) {
      created.push(Object.assign(this, { title, opts }));
    }
  }
  vi.stubGlobal("Notification", FakeNotification);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetNotify();
  resetNotifications();
  useUi.getState().selectThread(null);
});

const input = { title: "Finished: A", body: "done", threadId: "t1", tag: "t1:finished" };

describe("notify", () => {
  it("does nothing while disabled", async () => {
    expect(await notify(input)).toBe(false);
    expect(created).toHaveLength(0);
  });

  it("dedupes by tag within 5 seconds", async () => {
    useNotifications.getState().setEnabled(true);
    expect(await notify(input, 1000)).toBe(true);
    expect(await notify(input, 3000)).toBe(false);
    expect(await notify(input, 6500)).toBe(true);
    expect(created).toHaveLength(2);
  });

  it("selects the thread when the notification is clicked", async () => {
    useNotifications.getState().setEnabled(true);
    await notify(input);
    created[0]!.onclick!();
    expect(useUi.getState().selectedThreadId).toBe("t1");
  });
});
