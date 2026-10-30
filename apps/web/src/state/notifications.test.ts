import { afterEach, describe, expect, it } from "vitest";
import { resetNotifications, useNotifications } from "./notifications.ts";

afterEach(resetNotifications);

describe("notification prefs", () => {
  it("defaults off and persists changes", () => {
    expect(useNotifications.getState().enabled).toBe(false);
    useNotifications.getState().setEnabled(true);
    useNotifications.getState().setSound(true);
    useNotifications.getState().toggleProjectMuted("p1");
    expect(JSON.parse(localStorage.getItem("tide.notifications")!)).toEqual({
      enabled: true,
      sound: true,
      mutedProjectIds: ["p1"],
    });
    useNotifications.getState().toggleProjectMuted("p1");
    expect(useNotifications.getState().mutedProjectIds).toEqual([]);
  });
});
