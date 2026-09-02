import { afterEach, describe, expect, it } from "vitest";
import { subscribeWatch } from "./files.ts";
import { useModel } from "./model.ts";
import { useToasts } from "./toast.ts";
import { mockRpc, mockStream, resetUi } from "../testHarness.ts";

afterEach(() => {
  // the connection goes first: resetUi() re-reads it to forget the reconnect history
  useModel.setState({ status: "closed" });
  resetUi();
  useToasts.setState({ toasts: [] });
});

/** Drops the socket and brings it back, as the connection layer would. */
function reconnect(): void {
  useModel.setState({ status: "reconnecting" });
  useModel.setState({ status: "open" });
}

const watches = (streams: { method: string }[]): number =>
  streams.filter((s) => s.method === "fs.watch").length;

describe("fs.watch across a reconnect", () => {
  it("re-opens a watch that the dropped connection killed", async () => {
    mockRpc({ "fs.list": () => ({ entries: [] }) });
    const { streams } = mockStream();
    useModel.setState({ status: "open" });

    const release = subscribeWatch("t1");
    expect(watches(streams)).toBe(1);

    // the socket dies: the server stream ends and the dead watcher must not be cached
    streams[0]?.end(new Error("connection lost"));
    await Promise.resolve();
    await Promise.resolve();

    reconnect();

    expect(watches(streams)).toBe(2);
    expect(streams[1]?.params).toEqual({ threadId: "t1" });
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["Reconnected"]);
    release();
  });

  it("leaves released watches alone", () => {
    mockRpc({ "fs.list": () => ({ entries: [] }) });
    const { streams } = mockStream();
    useModel.setState({ status: "open" });

    subscribeWatch("t1")();
    expect(streams[0]?.cancelled).toBe(true);

    reconnect();

    expect(watches(streams)).toBe(1);
  });

  it("says nothing on the first connection", () => {
    mockRpc({ "fs.list": () => ({ entries: [] }) });
    mockStream();
    useModel.setState({ status: "connecting" });
    useModel.setState({ status: "open" });

    expect(useToasts.getState().toasts).toHaveLength(0);
  });
});
