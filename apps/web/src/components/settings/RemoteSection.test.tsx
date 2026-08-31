import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RemoteSection } from "./RemoteSection.tsx";
import { attachFakeStore, mockRpc, modelWith, resetUi } from "../../testHarness.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const INFO = {
  environmentId: "env-1",
  version: "0.0.0",
  startedAt: 1,
  remote: {
    host: "0.0.0.0",
    port: 3777,
    lanUrls: ["http://192.168.1.20:3777", "http://10.0.0.5:3777"],
    pairingUrl: "http://192.168.1.20:3777/?token=secret",
  },
};

describe("Settings › Remote", () => {
  it("lists LAN URLs and copies one", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mockRpc({ "server.info": () => INFO });
    attachFakeStore(modelWith({}));
    render(<RemoteSection />);

    expect(await screen.findByText("http://192.168.1.20:3777")).toBeDefined();
    const urls = screen.getByLabelText("LAN URLs");
    expect(urls.textContent).toContain("http://10.0.0.5:3777");
    expect(screen.getByText("0.0.0.0:3777")).toBeDefined();

    fireEvent.click(within(urls).getAllByText("Copy")[0] as HTMLElement);
    expect(writeText).toHaveBeenCalledWith("http://192.168.1.20:3777");
  });

  it("warns about the token in the pairing URL and copies it", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mockRpc({ "server.info": () => INFO });
    attachFakeStore(modelWith({}));
    render(<RemoteSection />);

    const heading = await screen.findByText("Pairing URL");
    expect(screen.getByText(/share only with your own devices/)).toBeDefined();
    fireEvent.click(within(heading.parentElement as HTMLElement).getByText("Copy"));
    expect(writeText).toHaveBeenCalledWith(INFO.remote.pairingUrl);
  });

  it("points at --host 0.0.0.0 when the server is local-only", async () => {
    mockRpc({ "server.info": () => ({ environmentId: "env-1", version: "0.0.0", startedAt: 1 }) });
    attachFakeStore(modelWith({}));
    render(<RemoteSection />);
    expect(await screen.findByText(/tide-server --host 0.0.0.0/)).toBeDefined();
    expect(screen.getByText(/tailscale serve 3777/)).toBeDefined();
    expect(screen.getByText(/ssh -L 3777:127.0.0.1:3777 host/)).toBeDefined();
  });
});
