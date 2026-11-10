import { encodeResponse, parse, sameName, TYPE, type ServiceRecords } from "./packet.ts";
import { dgramSocketFactory, MDNS_GROUP, MDNS_PORT, type MdnsSocket, type MdnsSocketFactory, type Remote } from "./socket.ts";

export const TIDE_SERVICE = "_tide._tcp.local";
const TTL = 120;
const utf8 = new TextEncoder();

export interface ResponderOptions {
  environmentId: string;
  /** read on every answer, so a rename shows up in the TXT record */
  name: () => string;
  version: string;
  protocol: number;
  port: number;
  /** R19: the server listens with TLS; the TXT record says `tls=1` */
  tls?: boolean;
  /** the addresses to advertise, read on every answer */
  ips: () => string[];
  socketFactory?: MdnsSocketFactory;
  log: (msg: string) => void;
}

/** Short, stable suffix from the environment id (keeps two machines both named "mac" apart). */
function shortId(environmentId: string): string {
  return environmentId.replace(/[^a-z0-9]/gi, "").slice(-6).toLowerCase() || "tide";
}

/** A DNS-SD instance label: no dots or control characters, ≤ 63 bytes with the id suffix. */
export function instanceLabel(name: string, environmentId: string): string {
  const suffix = `-${shortId(environmentId)}`;
  // the default name is the hostname, often "box.local": drop the domain before dots become spaces
  let clean = name.replace(/\.local\.?$/i, "").replace(/[\u0000-\u001f\u007f.]/g, " ").replace(/\s+/g, " ").trim() || "tide";
  while (utf8.encode(clean + suffix).length > 63) clean = Array.from(clean).slice(0, -1).join("");
  return clean + suffix;
}

/**
 * Advertises this server as `_tide._tcp` on the LAN (RFC 6762/6763, PTR + SRV + TXT + A).
 * Answers PTR queries for the service and SRV/TXT/A/ANY queries for its own names; announces
 * once on start and says goodbye (TTL 0) on stop. A socket that cannot be opened leaves it
 * disabled after one log line.
 */
export class MdnsResponder {
  private readonly options: ResponderOptions;
  private readonly instance: string;
  private readonly host: string;
  private socket: MdnsSocket | undefined;

  constructor(options: ResponderOptions) {
    this.options = options;
    this.instance = instanceLabel(options.name(), options.environmentId);
    this.host = `tide-${shortId(options.environmentId)}.local`;
  }

  get enabled(): boolean {
    return this.socket !== undefined;
  }

  get instanceName(): string {
    return `${this.instance}.${TIDE_SERVICE}`;
  }

  async start(): Promise<void> {
    if (this.socket !== undefined) return;
    try {
      this.socket = await (this.options.socketFactory ?? dgramSocketFactory)("responder");
    } catch (err) {
      this.options.log(`[mdns] LAN discovery off: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.socket.onMessage((msg, from) => this.onQuery(msg, from));
    this.socket.send(this.response(TTL), MDNS_PORT, MDNS_GROUP);
  }

  async stop(): Promise<void> {
    const socket = this.socket;
    if (socket === undefined) return;
    this.socket = undefined;
    socket.send(this.response(0), MDNS_PORT, MDNS_GROUP);
    await socket.close();
  }

  private records(ttl: number): ServiceRecords {
    const o = this.options;
    return {
      instance: this.instance,
      service: TIDE_SERVICE,
      host: this.host,
      port: o.port,
      ips: o.ips(),
      ttl,
      txt: { envId: o.environmentId, name: o.name(), version: o.version, protocol: String(o.protocol), port: String(o.port), ...(o.tls === true ? { tls: "1" } : {}) },
    };
  }

  private response(ttl: number, legacy?: { id: number; question: { name: string; type: number } }): Uint8Array {
    // legacy unicast replies repeat the query id and question, without cache-flush bits (RFC 6762 §6.7)
    return encodeResponse(this.records(ttl), legacy === undefined ? {} : { id: legacy.id, question: legacy.question, flush: false });
  }

  private asksForUs(name: string, type: number): boolean {
    if (type === TYPE.PTR || type === TYPE.ANY) if (sameName(name, TIDE_SERVICE)) return true;
    if (type === TYPE.SRV || type === TYPE.TXT || type === TYPE.ANY) if (sameName(name, this.instanceName)) return true;
    if (type === TYPE.A || type === TYPE.ANY) if (sameName(name, this.host)) return true;
    return false;
  }

  private onQuery(msg: Uint8Array, from: Remote): void {
    const socket = this.socket;
    const query = parse(msg);
    if (socket === undefined || query === undefined || (query.flags & 0x8000) !== 0) return;
    const asked = query.questions.find((q) => this.asksForUs(q.name, q.type));
    if (asked === undefined) return;
    // known-answer suppression: the asker already holds our PTR with at least half its TTL left
    if (query.answers.some((a) => a.type === TYPE.PTR && a.ptr !== undefined && sameName(a.ptr, this.instanceName) && a.ttl >= TTL / 2)) return;
    if (from.port !== MDNS_PORT) {
      socket.send(this.response(TTL, { id: query.id, question: { name: asked.name, type: asked.type } }), from.port, from.address);
      return;
    }
    const unicast = query.questions.every((q) => q.unicast);
    if (unicast) socket.send(this.response(TTL), MDNS_PORT, from.address);
    else socket.send(this.response(TTL), MDNS_PORT, MDNS_GROUP);
  }
}
