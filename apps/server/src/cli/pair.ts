import WebSocket from "ws";
import type { EnvProbe, PairedClient } from "@tide/contracts";
import { localHostFor } from "../rpc/remote.ts";
import { encodeQr, renderQr } from "./qr.ts";
import { readRuntime, readToken, tideHomeOf } from "./runtime.ts";

export interface PairCode {
  code: string;
  expiresAt: number;
  urls: string[];
}

export class PairError extends Error {
  override name = "PairError";
}

/** What a pairing QR encodes: the first URL with the code in the fragment (never sent to a server). */
export function pairLink(urls: string[], code: string): string | undefined {
  const base = urls[0];
  return base === undefined ? undefined : `${base.replace(/\/+$/, "")}/#pair=${code}`;
}

export function pairText(input: PairCode & { name: string; qr?: string; now?: number }): string {
  const minutes = Math.max(1, Math.round((input.expiresAt - (input.now ?? Date.now())) / 60_000));
  const lines = [`Pair with "${input.name}"`, "", `  code: ${input.code}   (single use, expires in ${minutes} min)`, ""];
  lines.push("  In a Tide client: Environments → Add, enter one of these URLs and the code:");
  for (const url of input.urls) lines.push(`    ${url}`);
  const link = pairLink(input.urls, input.code);
  if (input.qr !== undefined && link !== undefined) lines.push("", `  or scan (opens ${link}):`, "", input.qr);
  return lines.join("\n");
}

/** One RPC call over a ticketed socket; resolves with the result or rejects with the error. */
function rpcOnce<T>(url: string, method: string, params: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => ws.send(JSON.stringify({ id: "1", method, params })));
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as { id: string; result?: T; error?: { message: string } };
      if (frame.id !== "1") return;
      ws.close();
      if (frame.error) reject(new PairError(frame.error.message));
      else resolve(frame.result as T);
    });
    ws.once("error", (err) => reject(new PairError(`websocket: ${err.message}`)));
    ws.once("close", (code) => {
      if (code === 4401) reject(new PairError("the server refused the ticket"));
    });
  });
}

const stamp = (ms: number | undefined): string => (ms === undefined ? "-" : new Date(ms).toISOString().slice(0, 16).replace("T", " "));

/** `tide pair --list`: one row per paired device (times in UTC). */
export function clientsTable(clients: PairedClient[]): string {
  if (clients.length === 0) return "No paired devices. Run `tide pair` to pair one.";
  const rows = [["ID", "NAME", "CREATED", "LAST SEEN", "LAST ADDRESS"], ...clients.map((c) => [c.id, c.name, stamp(c.createdAt), stamp(c.lastSeenAt), c.lastAddress ?? "-"])];
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ")).join("\n");
}

export interface PairOptions {
  port?: number;
  host?: string;
  qr: boolean;
  env?: NodeJS.ProcessEnv;
  /** colour the QR (a TTY) */
  ansi?: boolean;
  /** R17: list paired devices instead of issuing a code */
  list?: boolean;
  /** R17: revoke this paired device's token (its open sockets close) */
  revoke?: string;
}

/**
 * `tide pair`: talks to the server running on this machine over loopback with the token from
 * `<TIDE_HOME>/server.json` (that file is the proof of being local), asks for a pairing code and
 * prints it with the URLs and a QR. `--list` / `--revoke <id>` manage the paired devices.
 */
export async function runPair(options: PairOptions): Promise<string> {
  const tideHome = tideHomeOf(options.env);
  const token = readToken(tideHome);
  if (token === undefined) throw new PairError(`no server identity in ${tideHome}/server.json — start the server first (tide serve)`);
  const runtime = readRuntime(tideHome);
  const port = options.port ?? runtime?.port ?? 3777;
  const host = options.host ?? localHostFor(runtime?.host ?? "127.0.0.1");
  const base = `http://${host}:${port}`;
  let probe: EnvProbe;
  let ticket: string;
  try {
    probe = (await (await fetch(`${base}/api/env`)).json()) as EnvProbe;
    const res = await fetch(`${base}/api/auth/ws-ticket`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401) throw new PairError(`the server on ${base} does not accept the token in ${tideHome}/server.json (another TIDE_HOME?)`);
    ticket = ((await res.json()) as { ticket: string }).ticket;
  } catch (err) {
    if (err instanceof PairError) throw err;
    throw new PairError(`no Tide server answering on ${base} — start one with \`tide serve\` (or pass --port)`);
  }
  const wsUrl = `ws://${host}:${port}/ws?wsTicket=${ticket}`;
  if (options.list) return clientsTable((await rpcOnce<{ clients: PairedClient[] }>(wsUrl, "env.clients.list", {})).clients);
  if (options.revoke !== undefined) {
    const { ok } = await rpcOnce<{ ok: boolean }>(wsUrl, "env.clients.revoke", { id: options.revoke });
    if (!ok) throw new PairError(`no paired device ${options.revoke} (see tide pair --list)`);
    return `revoked ${options.revoke}; its open connections were closed and it must pair again`;
  }
  const code = await rpcOnce<PairCode>(wsUrl, "env.pairingCode", {});
  const link = pairLink(code.urls, code.code);
  let qr: string | undefined;
  if (options.qr && link !== undefined) {
    try {
      qr = renderQr(encodeQr(link), { ansi: options.ansi ?? false });
    } catch {
      qr = undefined; // a URL too long for the small encoder: the text is enough
    }
  }
  return pairText({ ...code, name: probe.name, ...(qr !== undefined ? { qr } : {}) });
}
