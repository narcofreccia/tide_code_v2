import type { MdnsSocket, MdnsSocketFactory, Remote } from "./socket.ts";

/** Test double for a UDP socket: records sends, lets the test deliver datagrams. */
export class FakeSocket implements MdnsSocket {
  readonly role: "responder" | "browser";
  readonly sent: { msg: Uint8Array; port: number; address: string }[] = [];
  closed = false;
  private listener: ((msg: Uint8Array, from: Remote) => void) | undefined;

  constructor(role: "responder" | "browser") {
    this.role = role;
  }

  onMessage(listener: (msg: Uint8Array, from: Remote) => void): void {
    this.listener = listener;
  }

  send(msg: Uint8Array, port: number, address: string): void {
    this.sent.push({ msg, port, address });
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  deliver(msg: Uint8Array, from: Remote): void {
    this.listener?.(msg, from);
  }
}

/** A factory that keeps every socket it made; `fail` makes it throw like a host without multicast. */
export function fakeSocketFactory(options: { fail?: boolean } = {}): MdnsSocketFactory & { sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const factory = async (role: "responder" | "browser"): Promise<MdnsSocket> => {
    if (options.fail === true) throw new Error("addMembership ENOPROTOOPT");
    const socket = new FakeSocket(role);
    sockets.push(socket);
    return socket;
  };
  return Object.assign(factory, { sockets });
}
