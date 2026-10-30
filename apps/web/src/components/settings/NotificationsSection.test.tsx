import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NotificationsSection } from "./NotificationsSection.tsx";
import { resetNotifications, useNotifications } from "../../state/notifications.ts";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import type { Project } from "@tide/contracts";

let permission = "default";

beforeEach(() => {
  permission = "default";
  class FakeNotification {
    static get permission() {
      return permission;
    }
    static requestPermission = vi.fn(async () => {
      permission = permission === "denied" ? "denied" : "granted";
      return permission;
    });
  }
  vi.stubGlobal("Notification", FakeNotification);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetNotifications();
  resetUi();
});

describe("Notifications settings", () => {
  it("requests permission and enables", async () => {
    render(<NotificationsSection />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("switch", { name: /Notify me/ }));
    await act(async () => undefined);
    expect(useNotifications.getState().enabled).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: /sound/ }));
    expect(useNotifications.getState().sound).toBe(true);
  });

  it("shows help when denied", async () => {
    permission = "denied";
    render(<NotificationsSection />);
    await act(async () => undefined);
    expect(screen.getByRole("status").textContent).toMatch(/blocked/);
    expect((screen.getByRole("switch", { name: /Notify me/ }) as HTMLInputElement).disabled).toBe(true);
  });

  it("mutes a project", async () => {
    const project = { id: "p1", title: "Alpha" } as Project;
    attachFakeStore(modelWith({ projects: { p1: project }, threads: { t: makeThread("t") } }));
    render(<NotificationsSection />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("switch", { name: "Alpha" }));
    expect(useNotifications.getState().mutedProjectIds).toEqual(["p1"]);
  });
});
