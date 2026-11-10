import { describe, expect, it } from "vitest";
import { browse, type BrowseTimers } from "./browser.ts";
import { fakeSocketFactory, type FakeSocket } from "./fakeSocket.ts";
import { encodeResponse, parse, TYPE, type ServiceRecords } from "./packet.ts";
import { TIDE_SERVICE } from "./responder.ts";

function manualTimers(): BrowseTimers & { fire(): void; delays: number[] } {
  const pending: (() => void)[] = [];
  const delays: number[] = [];
  return {
    delays,
    setTimeout(fn, ms) {
      pending.push(fn);
      delays.push(ms);
      return pending.length;
    },
    fire() {
      for (const fn of pending.splice(0)) fn();
    },
  };
}

const peer = (envId: string, patch: Partial<ServiceRecords> = {}): Uint8Array =>
  encodeResponse({
    instance: `box-${envId}`,
    service: TIDE_SERVICE,
    host: `tide-${envId}.local`,
    port: 3777,
    ips: ["192.168.1.20"],
    ttl: 120,
    txt: { envId, name: `box ${envId}`, version: "0.9.0", protocol: "1", port: "3777" },
    ...patch,
  });

/** Starts a browse and hands back the socket it opened once the query is out. */
async function start(selfEnvironmentId = "self") {
  const factory = fakeSocketFactory();
  const timers = manualTimers();
  const result = browse({ timeoutMs: 1500, selfEnvironmentId, timers, socketFactory: factory });
  await Promise.resolve();
  await Promise.resolve();
  const socket = factory.sockets[0] as FakeSocket;
  return { result, socket, timers };
}

describe("browse", () => {
  it("sends one PTR query to the mDNS group from an ephemeral socket", async () => {
    const { result, socket, timers } = await start();
    expect(socket.role).toBe("browser");
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({ port: 5353, address: "224.0.0.251" });
    expect(parse(socket.sent[0]?.msg ?? new Uint8Array())?.questions).toEqual([{ name: TIDE_SERVICE, type: TYPE.PTR, unicast: false }]);
    expect(timers.delays).toEqual([1500]);
    timers.fire();
    expect(await result).toEqual([]);
    expect(socket.closed).toBe(true);
  });

  it("collects peers until the timer fires, deduped by environment id, without itself", async () => {
    const { result, socket, timers } = await start("self");
    const from = { address: "192.168.1.20", port: 5353 };
    socket.deliver(peer("e1"), from);
    socket.deliver(peer("e1", { ips: ["192.168.1.99"] }), from);
    socket.deliver(peer("self"), { address: "127.0.0.1", port: 5353 });
    socket.deliver(peer("e2", { port: 4000, ips: [], txt: { envId: "e2", name: "nas", version: "1.0.0", protocol: "1" } }), { address: "192.168.1.30", port: 5353 });
    // goodbyes, junk and queries are ignored
    socket.deliver(peer("e3", { ttl: 0 }), from);
    socket.deliver(Uint8Array.from([9, 9, 9]), from);
    timers.fire();
    socket.deliver(peer("late"), from);
    expect(await result).toEqual([
      { environmentId: "e1", name: "box e1", version: "0.9.0", protocol: 1, host: "192.168.1.20", port: 3777, urls: ["http://192.168.1.20:3777"] },
      // no A record: the sender's address; the port from SRV
      { environmentId: "e2", name: "nas", version: "1.0.0", protocol: 1, host: "192.168.1.30", port: 4000, urls: ["http://192.168.1.30:4000"] },
    ]);
  });

  it("brackets an IPv6 host in the URL", async () => {
    const { result, socket, timers } = await start();
    socket.deliver(peer("v6", { ips: ["fd00::20"] }), { address: "192.168.1.20", port: 5353 });
    timers.fire();
    expect((await result)[0]).toMatchObject({ host: "fd00::20", urls: ["http://[fd00::20]:3777"] });
  });

  it("builds https URLs and sets tls for a peer that says tls=1 (R19)", async () => {
    const { result, socket, timers } = await start();
    socket.deliver(peer("s1", { txt: { envId: "s1", name: "nas", version: "1.0.0", protocol: "1", port: "3777", tls: "1" } }), { address: "192.168.1.20", port: 5353 });
    timers.fire();
    expect((await result)[0]).toMatchObject({ environmentId: "s1", urls: ["https://192.168.1.20:3777"], tls: true });
  });

  it("rejects when no socket can be opened", async () => {
    await expect(browse({ timeoutMs: 200, selfEnvironmentId: "s", timers: manualTimers(), socketFactory: fakeSocketFactory({ fail: true }) })).rejects.toThrow();
  });
});
