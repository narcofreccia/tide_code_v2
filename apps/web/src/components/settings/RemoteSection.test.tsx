import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RemoteSection } from "./RemoteSection.tsx";

const connectTo = vi.fn();
vi.mock("../../lib/bootstrap.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/bootstrap.ts")>()),
  connectTo: (url: string, token: string) => connectTo(url, token),
}));
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
  it("lists LAN page URLs (with ?server=) and copies one", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mockRpc({ "server.info": () => INFO });
    attachFakeStore(modelWith({}));
    render(<RemoteSection />);

    const page = "http://192.168.1.20:3777/?server=ws%3A%2F%2F192.168.1.20%3A3777%2Fws&paired=1";
    expect(await screen.findByText(page)).toBeDefined();
    const urls = screen.getByLabelText("LAN URLs");
    expect(urls.textContent).toContain("http://10.0.0.5:3777/?server=");
    // the socket url stays visible as the secondary line
    expect(screen.getByText("ws://192.168.1.20:3777/ws")).toBeDefined();
    expect(screen.getByText("0.0.0.0:3777")).toBeDefined();

    fireEvent.click(within(urls).getAllByText("Copy")[0] as HTMLElement);
    expect(writeText).toHaveBeenCalledWith(page);
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

  it("connects to another server from the form", async () => {
    mockRpc({ "server.info": () => INFO });
    attachFakeStore(modelWith({}));
    render(<RemoteSection />);
    const form = screen.getByRole("form", { name: "Connect to another server" });
    expect((within(form).getByText("Connect") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(form).getByLabelText("Server URL"), { target: { value: "http://10.0.0.9:3777" } });
    fireEvent.change(within(form).getByLabelText("Server token"), { target: { value: "tok" } });
    fireEvent.click(within(form).getByText("Connect"));

    // a pasted page url becomes its socket url
    expect(connectTo).toHaveBeenCalledWith("ws://10.0.0.9:3777/ws", "tok");
    expect((within(form).getByLabelText("Server token") as HTMLInputElement).value).toBe("");
  });
});
