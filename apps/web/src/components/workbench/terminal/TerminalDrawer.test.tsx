import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockRpc, mockStream, resetUi } from "../../../testHarness.ts";
import { useModel } from "../../../state/model.ts";
import { setDrawerOpen, useTerminals } from "../../../state/terminals.ts";
import { TerminalDrawer } from "./TerminalDrawer.tsx";

interface FakeTerm {
  written: string[];
  data?: (input: string) => void;
}

const terms: FakeTerm[] = [];

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    private readonly self: FakeTerm = { written: [] };
    constructor() {
      terms.push(this.self);
    }
    loadAddon(): void {}
    open(): void {}
    write(data: string): void {
      this.self.written.push(data);
    }
    onData(handler: (input: string) => void) {
      this.self.data = handler;
      return { dispose: () => undefined };
    }
    dispose(): void {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit(): void {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

afterEach(() => {
  cleanup();
  resetUi();
  terms.length = 0;
});

describe("TerminalDrawer", () => {
  it("stays closed until toggled", () => {
    mockRpc({});
    const { container } = render(<TerminalDrawer threadId="t1" />);
    expect(container.firstChild).toBeNull();
  });

  it("lists the thread's ptys when it opens", async () => {
    const rpc = mockRpc({ "pty.list": () => ({ ptys: [{ ptyId: "p1", title: "zsh", alive: true }] }) });
    mockStream();
    setDrawerOpen(true);
    render(<TerminalDrawer threadId="t1" />);
    await screen.findByRole("tab", { name: "zsh" });
    expect(rpc).toHaveBeenCalledWith("pty.list", { threadId: "t1" });
  });

  it("creates a pty with the current size", async () => {
    const rpc = mockRpc({
      "pty.list": () => ({ ptys: [] }),
      "pty.create": () => ({ ptyId: "p9" }),
    });
    mockStream();
    setDrawerOpen(true);
    render(<TerminalDrawer threadId="t1" />);
    await screen.findByText(/No terminal yet/);
    fireEvent.click(screen.getByLabelText("New terminal"));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("pty.create", { threadId: "t1", cols: 80, rows: 24 }));
    expect(useTerminals.getState().active.t1).toBe("p9");
  });

  it("attaches, prints output and forwards keystrokes", async () => {
    const rpc = mockRpc({
      "pty.list": () => ({ ptys: [{ ptyId: "p1", alive: true }] }),
      "pty.write": () => ({ ok: true }),
    });
    const { streams } = mockStream();
    setDrawerOpen(true);
    render(<TerminalDrawer threadId="t1" />);
    await waitFor(() => expect(terms).toHaveLength(1));
    const attach = streams.find((s) => s.method === "pty.attach");
    expect(attach?.params).toEqual({ ptyId: "p1" });

    act(() => attach?.push({ kind: "data", data: "$ ls\r\n" }));
    expect(terms[0]?.written).toContain("$ ls\r\n");

    act(() => terms[0]?.data?.("echo hi\r"));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("pty.write", { ptyId: "p1", data: "echo hi\r" }));

    act(() => attach?.push({ kind: "exit", code: 3 }));
    expect(terms[0]?.written.join("")).toContain("[exited code 3]");
  });

  it("re-attaches and re-lists after the connection comes back", async () => {
    const rpc = mockRpc({ "pty.list": () => ({ ptys: [{ ptyId: "p1", alive: true }] }) });
    const { streams } = mockStream();
    setDrawerOpen(true);
    useModel.setState({ status: "open" });
    render(<TerminalDrawer threadId="t1" />);
    await waitFor(() => expect(streams.filter((s) => s.method === "pty.attach")).toHaveLength(1));
    const listCalls = rpc.mock.calls.filter(([method]) => method === "pty.list").length;

    act(() => {
      streams[0]?.end(new Error("connection lost"));
      useModel.setState({ status: "reconnecting" });
      useModel.setState({ status: "open" });
    });

    await waitFor(() => expect(streams.filter((s) => s.method === "pty.attach")).toHaveLength(2));
    await waitFor(() =>
      expect(rpc.mock.calls.filter(([method]) => method === "pty.list").length).toBe(listCalls + 1),
    );
    useModel.setState({ status: "closed" });
  });

  it("kills a pty when its tab is closed", async () => {
    const rpc = mockRpc({
      "pty.list": () => ({ ptys: [{ ptyId: "p1", alive: true }] }),
      "pty.kill": () => ({ ok: true }),
    });
    mockStream();
    setDrawerOpen(true);
    render(<TerminalDrawer threadId="t1" />);
    const close = await screen.findByLabelText("Close sh 1");
    fireEvent.click(close);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("pty.kill", { ptyId: "p1" }));
  });
});
