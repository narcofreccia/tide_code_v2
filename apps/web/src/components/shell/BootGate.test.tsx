import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useModel } from "../../state/model.ts";
import { installFakeConnections, type FakeEnvConnection } from "../../state/fakeEnvConnection.ts";
import { resetEnvManager, startEnvironments } from "../../state/envManager.ts";
import { resetUi } from "../../testHarness.ts";
import { BootGate } from "./BootGate.tsx";
import { RECONNECT_BANNER_DELAY_MS } from "./ReconnectBanner.tsx";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  resetEnvManager();
  resetUi();
  useModel.setState({ status: "closed", lastError: null });
  vi.useRealTimers();
});

const tick = (ms: number): void => act(() => void vi.advanceTimersByTime(ms));
const set = (status: "connecting" | "open" | "reconnecting" | "closed"): void => act(() => void useModel.setState({ status }));

describe("BootGate: boot", () => {
  it("shows nothing extra when the connection opens before 8 s", () => {
    set("connecting");
    render(<BootGate>app</BootGate>);
    expect(screen.getByText("app")).toBeTruthy();
    set("open");
    tick(8000);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Reconnecting…")).toBeNull();
  });

  it("overlays the failed screen when never connected at 8 s, keeping the app mounted", () => {
    set("connecting");
    render(<BootGate>app</BootGate>);
    tick(7999);
    expect(screen.queryByRole("alert")).toBeNull();
    tick(1);
    expect(screen.getByRole("alert").textContent).toContain("VITE_TIDE_TOKEN");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByText("app")).toBeTruthy();
    // and lifts by itself once it opens
    set("open");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("BootGate: a drop after the app was open", () => {
  it("never shows the full-screen failure; a banner after the delay, lifted on reopen", () => {
    set("connecting");
    render(<BootGate>app</BootGate>);
    set("open");
    tick(20_000);
    set("reconnecting");
    // a short blip stays silent
    tick(RECONNECT_BANNER_DELAY_MS - 1000);
    expect(screen.queryByText("Reconnecting…")).toBeNull();
    tick(1000);
    expect(screen.getByText("Reconnecting…")).toBeTruthy();
    expect(screen.getByText("0:02")).toBeTruthy();
    tick(10_000);
    expect(screen.getByText("0:12")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("app")).toBeTruthy();
    set("open");
    expect(screen.queryByText("Reconnecting…")).toBeNull();
    // the next drop starts its own clock
    set("reconnecting");
    tick(RECONNECT_BANNER_DELAY_MS);
    expect(screen.getByText("0:02")).toBeTruthy();
  });
});

describe("BootGate with the environment manager", () => {
  let local: FakeEnvConnection;
  beforeEach(() => {
    const fakes = installFakeConnections();
    startEnvironments({ url: "ws://127.0.0.1:3777/ws", token: "tok" });
    local = fakes.byId("local");
  });

  it("Retry now re-walks the primary's routes", () => {
    render(<BootGate>app</BootGate>);
    act(() => local.emit({ state: "connected", environmentId: "local" }));
    act(() => local.emit({ state: "offline", error: "connection lost" }));
    expect(useModel.getState().status).toBe("reconnecting");
    tick(RECONNECT_BANNER_DELAY_MS);
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(local.probed).toBe(1);
  });

  it("a refused token gets its own message at once, which can be dismissed to a quiet line", () => {
    render(<BootGate>app</BootGate>);
    act(() => local.emit({ state: "unauthorized", error: "unauthorized: the token was refused (pair again)" }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("The server refused this device");
    expect(alert.textContent).not.toContain("Could not reach");
    fireEvent.click(screen.getByRole("button", { name: "Continue without a connection" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/refused this device's token/)).toBeTruthy();
    // a later boot timeout does not cover it with the generic screen
    tick(8000);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
