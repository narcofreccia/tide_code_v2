import { describe, expect, it } from "vitest";
import { fakeSocketFactory, type FakeSocket } from "./fakeSocket.ts";
import { encodeQuery, encodeResponse, parse, TYPE } from "./packet.ts";
import { instanceLabel, MdnsResponder, TIDE_SERVICE } from "./responder.ts";

async function started(name = "Studio Mac") {
  const factory = fakeSocketFactory();
  const logs: string[] = [];
  const responder = new MdnsResponder({
    environmentId: "env-0011aabbcc",
    name: () => name,
    version: "0.9.0",
    protocol: 1,
    port: 3777,
    ips: () => ["192.168.1.42"],
    socketFactory: factory,
    log: (m) => logs.push(m),
  });
  await responder.start();
  const socket = factory.sockets[0] as FakeSocket;
  return { responder, socket, logs };
}

const fromLan = { address: "192.168.1.9", port: 5353 };

describe("MdnsResponder", () => {
  it("announces once on start with PTR, SRV, TXT and A", async () => {
    const { responder, socket } = await started();
    expect(responder.enabled).toBe(true);
    expect(socket.role).toBe("responder");
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({ port: 5353, address: "224.0.0.251" });
    const msg = parse(socket.sent[0]?.msg ?? new Uint8Array());
    expect(msg?.answers[0]?.ptr).toBe("Studio Mac-aabbcc._tide._tcp.local");
    const txt = msg?.additionals.find((r) => r.type === TYPE.TXT)?.txt;
    expect(txt).toEqual({ envid: "env-0011aabbcc", name: "Studio Mac", version: "0.9.0", protocol: "1", port: "3777" });
    expect(msg?.additionals.find((r) => r.type === TYPE.SRV)?.srv?.port).toBe(3777);
    expect(msg?.additionals.find((r) => r.type === TYPE.A)?.address).toBe("192.168.1.42");
  });

  it("adds tls=1 to the TXT record when the server listens with TLS (R19)", async () => {
    const factory = fakeSocketFactory();
    const responder = new MdnsResponder({ environmentId: "env-0011aabbcc", name: () => "Box", version: "0.9.0", protocol: 1, port: 3777, tls: true, ips: () => ["192.168.1.42"], socketFactory: factory, log: () => undefined });
    await responder.start();
    const msg = parse((factory.sockets[0] as FakeSocket).sent[0]?.msg ?? new Uint8Array());
    expect(msg?.additionals.find((r) => r.type === TYPE.TXT)?.txt).toMatchObject({ tls: "1" });
    await responder.stop();
  });

  it("answers PTR queries for _tide._tcp.local by multicast and ignores others", async () => {
    const { socket } = await started();
    socket.sent.length = 0;
    socket.deliver(encodeQuery("_airplay._tcp.local", TYPE.PTR), fromLan);
    socket.deliver(encodeQuery("_TIDE._tcp.local", TYPE.A), fromLan);
    // a response (QR bit) is never answered
    socket.deliver(encodeResponse({ instance: "x", service: TIDE_SERVICE, host: "x.local", port: 1, ips: [], txt: {}, ttl: 120 }), fromLan);
    socket.deliver(Uint8Array.from([1, 2, 3]), fromLan);
    expect(socket.sent).toHaveLength(0);

    socket.deliver(encodeQuery("_TIDE._tcp.local", TYPE.PTR), fromLan);
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({ port: 5353, address: "224.0.0.251" });
  });

  it("answers SRV/TXT for its instance and A for its host", async () => {
    const { responder, socket } = await started();
    socket.sent.length = 0;
    socket.deliver(encodeQuery(responder.instanceName, TYPE.SRV), fromLan);
    socket.deliver(encodeQuery(responder.instanceName, TYPE.TXT), fromLan);
    socket.deliver(encodeQuery("tide-aabbcc.local", TYPE.A), fromLan);
    socket.deliver(encodeQuery("someone-else._tide._tcp.local", TYPE.SRV), fromLan);
    expect(socket.sent).toHaveLength(3);
  });

  it("answers a legacy query from an ephemeral port by unicast, echoing id and question", async () => {
    const { socket } = await started();
    socket.sent.length = 0;
    socket.deliver(encodeQuery(TIDE_SERVICE, TYPE.PTR, { id: 4242 }), { address: "192.168.1.9", port: 50123 });
    expect(socket.sent[0]).toMatchObject({ port: 50123, address: "192.168.1.9" });
    const msg = parse(socket.sent[0]?.msg ?? new Uint8Array());
    expect(msg?.id).toBe(4242);
    expect(msg?.questions).toEqual([{ name: TIDE_SERVICE, type: TYPE.PTR, unicast: false }]);
  });

  it("a QU question gets a unicast reply to 5353", async () => {
    const { socket } = await started();
    socket.sent.length = 0;
    socket.deliver(encodeQuery(TIDE_SERVICE, TYPE.PTR, { unicast: true }), fromLan);
    expect(socket.sent[0]).toMatchObject({ port: 5353, address: "192.168.1.9" });
  });

  it("says goodbye with TTL 0 on stop and closes the socket", async () => {
    const { responder, socket } = await started();
    await responder.stop();
    expect(responder.enabled).toBe(false);
    expect(socket.closed).toBe(true);
    const bye = parse(socket.sent.at(-1)?.msg ?? new Uint8Array());
    expect(bye?.answers[0]?.ttl).toBe(0);
    expect(bye?.additionals.every((r) => r.ttl === 0)).toBe(true);
    await responder.stop(); // idempotent
    expect(socket.sent).toHaveLength(2);
  });

  it("stays disabled after one log line when the socket cannot be opened", async () => {
    const logs: string[] = [];
    const responder = new MdnsResponder({ environmentId: "e", name: () => "n", version: "1", protocol: 1, port: 1, ips: () => [], socketFactory: fakeSocketFactory({ fail: true }), log: (m) => logs.push(m) });
    await responder.start();
    expect(responder.enabled).toBe(false);
    expect(logs).toEqual(["[mdns] LAN discovery off: addMembership ENOPROTOOPT"]);
    await responder.stop();
  });

  it("builds instance labels without dots, within 63 bytes, with an id suffix", () => {
    expect(instanceLabel("andrea's.mac", "env-abc123")).toBe("andrea's mac-abc123");
    expect(instanceLabel("  ", "env-abc123")).toBe("tide-abc123");
    expect(instanceLabel("MacBook-Pro.local", "env-abc123")).toBe("MacBook-Pro-abc123");
    const long = instanceLabel("é".repeat(80), "env-abc123");
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(63);
    expect(long.endsWith("-abc123")).toBe(true);
  });
});
