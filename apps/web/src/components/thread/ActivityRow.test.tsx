import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Activity } from "@tide/contracts";
import { ActivityRow } from "./ActivityRow.tsx";
import { setProvidersForTest } from "../../state/providers.ts";
import { useUi } from "../../state/ui.ts";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { LOGGED_OUT, PROVIDER_FIXTURE } from "../settings/fixtures.ts";

function errorActivity(text: string): Activity {
  return { id: "a1", threadId: "t1", turnId: "u1", createdAt: 1, updatedAt: 1, kind: "error", text };
}

function setup(): void {
  attachFakeStore(modelWith({ threads: { t1: makeThread("t1") } }));
}

afterEach(() => {
  cleanup();
  resetUi();
});

describe("error activities", () => {
  it("offers Settings › Providers and the harness login for an auth failure", () => {
    setup();
    setProvidersForTest([{ ...LOGGED_OUT, loginCommand: "claude /login" }, ...PROVIDER_FIXTURE.slice(1)]);
    render(
      <ul>
        <ActivityRow activity={errorActivity("API error 401: not logged in")} />
      </ul>,
    );

    expect(screen.getByText("Run login").getAttribute("title")).toBe("claude /login");
    fireEvent.click(screen.getByText("Open Settings › Providers"));
    expect(useUi.getState().view).toBe("settings");
    expect(useUi.getState().settingsSection).toBe("providers");
  });

  it("offers no login command when the harness is not installed", () => {
    setup();
    setProvidersForTest([
      { kind: "claude", installed: false, loggedIn: false, hint: "install with `brew install claude`", models: [], caps: PROVIDER_FIXTURE[0]!.caps },
      ...PROVIDER_FIXTURE.slice(1),
    ]);
    render(
      <ul>
        <ActivityRow activity={errorActivity("401 unauthenticated")} />
      </ul>,
    );

    expect(screen.getByText("Open Settings › Providers")).toBeDefined();
    expect(screen.queryByText("Run login")).toBeNull();
  });

  it("leaves an ordinary error as a plain line", () => {
    setup();
    setProvidersForTest(PROVIDER_FIXTURE);
    render(
      <ul>
        <ActivityRow activity={errorActivity("ENOENT: no such file")} />
      </ul>,
    );

    expect(screen.getByText("ENOENT: no such file")).toBeDefined();
    expect(screen.queryByText("Open Settings › Providers")).toBeNull();
    expect(screen.queryByText("Run login")).toBeNull();
  });
});
