import { createSocket, type Socket } from "node:dgram";
import { networkInterfaces } from "node:os";

export const MDNS_GROUP = "224.0.0.251";
export const MDNS_PORT = 5353;

export interface Remote {
  address: string;
  port: number;
}

/** The slice of a UDP socket mDNS needs; tests hand in a fake. */
export interface MdnsSocket {
  onMessage(listener: (msg: Uint8Array, from: Remote) => void): void;
  send(msg: Uint8Array, port: number, address: string): void;
  /** resolves once sends already queued (a goodbye) have left */
  close(): Promise<void>;
}

/**
 * "responder": bound to 5353 and joined to the mDNS group (shared with the OS responder).
 * "browser": an ephemeral port; responders answer such a "legacy unicast" query straight back to it.
 */
export type MdnsSocketFactory = (role: "responder" | "browser") => Promise<MdnsSocket>;

function ipv4Interfaces(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) for (const info of list ?? []) if (info.family === "IPv4" && !info.internal) out.push(info.address);
  return out;
}

function wrap(socket: Socket): MdnsSocket {
  const inFlight = new Set<Promise<void>>();
  return {
    onMessage: (listener) => socket.on("message", (msg, rinfo) => listener(msg, { address: rinfo.address, port: rinfo.port })),
    send: (msg, port, address) => {
      const sent = new Promise<void>((resolve) => socket.send(msg, port, address, () => resolve()));
      inFlight.add(sent);
      void sent.then(() => inFlight.delete(sent));
    },
    close: async () => {
      // closing right away would cancel a queued goodbye
      await Promise.all(inFlight);
      try {
        socket.close();
      } catch {
        // already closed
      }
    },
  };
}

/**
 * The real `node:dgram` socket. Throws when the platform cannot bind or join the multicast
 * group (a sandbox, a runtime without multicast): callers then run with discovery off.
 */
export const dgramSocketFactory: MdnsSocketFactory = async (role) => {
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(role === "responder" ? MDNS_PORT : 0, () => {
        socket.off("error", reject);
        resolve();
      });
    });
    // a late send error (an interface going away) must not crash the server
    socket.on("error", () => undefined);
    if (role === "responder") {
      let joined = 0;
      for (const ip of ipv4Interfaces()) {
        try {
          socket.addMembership(MDNS_GROUP, ip);
          joined++;
        } catch {
          // best effort per interface
        }
      }
      if (joined === 0) socket.addMembership(MDNS_GROUP);
      socket.setMulticastTTL(255);
      socket.setMulticastLoopback(true);
    }
    return wrap(socket);
  } catch (err) {
    try {
      socket.close();
    } catch {
      // never opened
    }
    throw err;
  }
};
