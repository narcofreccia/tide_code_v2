import type { DiscoveredPeer } from "@tide/contracts";
import { encodeQuery, parse, sameName, TYPE, type ResourceRecord } from "./packet.ts";
import { TIDE_SERVICE } from "./responder.ts";
import { dgramSocketFactory, MDNS_GROUP, MDNS_PORT, type MdnsSocketFactory, type Remote } from "./socket.ts";

export interface BrowseTimers {
  setTimeout(fn: () => void, ms: number): unknown;
}

export interface BrowseOptions {
  timeoutMs: number;
  /** this server's own id: its responder answers too, and is dropped */
  selfEnvironmentId: string;
  timers?: BrowseTimers;
  socketFactory?: MdnsSocketFactory;
}

const realTimers: BrowseTimers = { setTimeout: (fn, ms) => setTimeout(fn, ms) };

function hostUrl(host: string, port: number): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/** The peer one response describes, or undefined when it is not a usable `_tide._tcp` answer. */
export function peerFrom(records: ResourceRecord[], from: Remote): DiscoveredPeer | undefined {
  const ptr = records.find((r) => r.type === TYPE.PTR && sameName(r.name, TIDE_SERVICE) && r.ttl > 0);
  if (ptr?.ptr === undefined) return undefined;
  const instance = ptr.ptr;
  const txt = records.find((r) => r.type === TYPE.TXT && sameName(r.name, instance))?.txt;
  const srv = records.find((r) => r.type === TYPE.SRV && sameName(r.name, instance))?.srv;
  const environmentId = txt?.["envid"];
  if (txt === undefined || environmentId === undefined || environmentId.length === 0) return undefined;
  const port = srv?.port ?? Number(txt["port"]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  const target = srv?.target;
  const onTarget = (r: ResourceRecord): boolean => target === undefined || sameName(r.name, target);
  const a = records.find((r) => r.type === TYPE.A && onTarget(r))?.address;
  const aaaa = records.find((r) => r.type === TYPE.AAAA && onTarget(r))?.address;
  const host = a ?? aaaa ?? from.address;
  const protocol = Number(txt["protocol"]);
  return {
    environmentId,
    name: txt["name"] ?? instance.split(".")[0] ?? environmentId,
    version: txt["version"] ?? "",
    protocol: Number.isFinite(protocol) ? protocol : 0,
    host,
    port,
    urls: [hostUrl(host, port)],
  };
}

/**
 * Asks the LAN who runs `_tide._tcp` and collects answers until the timer fires: one PTR
 * query from an ephemeral port, which responders answer by unicast (RFC 6762 §6.7). Rejects
 * when no socket can be opened.
 */
export async function browse(options: BrowseOptions): Promise<DiscoveredPeer[]> {
  const socket = await (options.socketFactory ?? dgramSocketFactory)("browser");
  const found = new Map<string, DiscoveredPeer>();
  socket.onMessage((msg, from) => {
    const message = parse(msg);
    if (message === undefined || (message.flags & 0x8000) === 0) return;
    const peer = peerFrom([...message.answers, ...message.additionals], from);
    if (peer === undefined || peer.environmentId === options.selfEnvironmentId || found.has(peer.environmentId)) return;
    found.set(peer.environmentId, peer);
  });
  return new Promise((resolve) => {
    (options.timers ?? realTimers).setTimeout(() => {
      void socket.close();
      resolve([...found.values()]);
    }, options.timeoutMs);
    socket.send(encodeQuery(TIDE_SERVICE, TYPE.PTR, { id: Math.floor(Math.random() * 0xffff) }), MDNS_PORT, MDNS_GROUP);
  });
}
