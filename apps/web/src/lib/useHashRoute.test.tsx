import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useHashRoute } from "./useHashRoute.ts";
import { buildPaletteItems } from "./paletteItems.ts";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../testHarness.ts";
import { useUi } from "../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

function Router() {
  useHashRoute();
  return null;
}

describe("useHashRoute", () => {
  it("restores the view from the hash on load, before the thread is known", () => {
    window.history.replaceState(null, "", "#/thread/t9");
    render(<Router />);
    expect(useUi.getState().view).toBe("thread");
    expect(useUi.getState().selectedThreadId).toBe("t9");
  });

  it("restores settings sections, experts boards and the all-threads list", () => {
    window.history.replaceState(null, "", "#/settings/remote");
    render(<Router />);
    expect(useUi.getState().view).toBe("settings");
    expect(useUi.getState().settingsSection).toBe("remote");
    cleanup();

    window.history.replaceState(null, "", "#/experts/x1");
    render(<Router />);
    expect(useUi.getState().view).toBe("experts");
    expect(useUi.getState().selectedExpertsSessionId).toBe("x1");
    cleanup();

    window.history.replaceState(null, "", "#/threads/p1");
    render(<Router />);
    expect(useUi.getState().view).toBe("threads");
    expect(useUi.getState().allThreadsProjectId).toBe("p1");
  });

  it("stamps the current view when the hash is empty", () => {
    render(<Router />);
    expect(window.location.hash).toBe("#/mission");
  });

  it("writes the hash when the store changes", () => {
    render(<Router />);
    act(() => useUi.getState().selectThread("t1"));
    expect(window.location.hash).toBe("#/thread/t1");
    act(() => useUi.getState().showSettings());
    expect(window.location.hash).toBe("#/settings/providers");
    act(() => useUi.getState().setSettingsSection("decisions"));
    expect(window.location.hash).toBe("#/settings/decisions");
    act(() => useUi.getState().showAllThreads("p1"));
    expect(window.location.hash).toBe("#/threads/p1");
  });

  it("follows hashchange (Back, a pasted link)", () => {
    render(<Router />);
    act(() => {
      window.history.replaceState(null, "", "#/thread/t2");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(useUi.getState().selectedThreadId).toBe("t2");
    act(() => {
      window.history.replaceState(null, "", "#/mission");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(useUi.getState().view).toBe("mission");
  });

  it("palette jump actions update the hash through the store", () => {
    const model = modelWith({
      projects: { p1: { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 } },
      threads: { t1: makeThread("t1", { title: "Refactor router" }) },
    });
    attachFakeStore(model);
    render(<Router />);
    const jump = buildPaletteItems({ model, selectedThreadId: null, selectedProjectId: null }).find((item) => item.id === "thread:t1");
    expect(jump).toBeDefined();
    act(() => jump!.run());
    expect(window.location.hash).toBe("#/thread/t1");
  });
});
