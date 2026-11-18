import WebSocket from "ws";
import type { UsageRepairResult } from "@tide/contracts";
import { loopbackFetch, trustFromFile, wsTlsOptions } from "../loopback.ts";
import { localHostFor } from "../rpc/remote.ts";
import { readRuntime, readToken, tideHomeOf } from "./runtime.ts";

export class UsageCliError extends Error {
  override name = "UsageCliError";
}

/** One RPC call to the server on this machine. */
export type LocalCall = (method: string, params: unknown) => Promise<unknown>;

/**
 * Calls the running server over loopback with the master token from `<TIDE_HOME>/server.json`.
 * The repair goes through the server's engine (its single writer) and never opens the database
 * itself, so a store the desktop app or a service has open cannot be corrupted.
 */
export function localRpc(env: NodeJS.ProcessEnv = process.env): LocalCall {
  return async (method, params) => {
    const tideHome = tideHomeOf(env);
    const token = readToken(tideHome);
    if (token === undefined) throw new UsageCliError(`no server identity in ${tideHome}/server.json — start the server first (tide serve)`);
    const runtime = readRuntime(tideHome);
    const host = localHostFor(runtime?.host ?? "127.0.0.1");
    const port = runtime?.port ?? 3777;
    const trust = trustFromFile(runtime?.certPath);
    const tls = trust !== undefined;
    const base = `${tls ? "https" : "http"}://${host}:${port}`;
    let ticket: string;
    try {
      const res = await loopbackFetch(trust)(`${base}/api/auth/ws-ticket`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
      if (res.status === 401) throw new UsageCliError(`the server on ${base} does not accept the token in ${tideHome}/server.json (another TIDE_HOME?)`);
      ticket = ((await res.json()) as { ticket: string }).ticket;
    } catch (err) {
      if (err instanceof UsageCliError) throw err;
      throw new UsageCliError(`no Tide server answering on ${base} — the repair runs through the server; start it (tide serve or the desktop app)`);
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${tls ? "wss" : "ws"}://${host}:${port}/ws?wsTicket=${ticket}`, wsTlsOptions(trust));
      ws.once("open", () => ws.send(JSON.stringify({ id: "1", method, params })));
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as { id?: string; result?: unknown; error?: { message: string } };
        if (frame.id !== "1") return;
        ws.close();
        if (frame.error) reject(new UsageCliError(frame.error.message));
        else resolve(frame.result);
      });
      ws.once("error", (err) => reject(new UsageCliError(`websocket: ${err.message}`)));
    });
  };
}

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** The repair's rows as a table, then the totals and what to do next. */
export function repairText(result: UsageRepairResult, options: { apply: boolean; includeHeuristic: boolean }): string {
  if (result.rows.length === 0) return "No inflated usage reports found. Nothing to repair.";
  const header = ["THREAD", "STORED", "CORRECTED", "EVIDENCE", ""];
  const rows = result.rows.map((r) => [r.threadTitle.length > 48 ? `${r.threadTitle.slice(0, 47)}…` : r.threadTitle, usd(r.storedUsd), usd(r.correctedUsd), r.evidence, r.applied ? "applied" : ""]);
  const table = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...table.map((r) => (r[i] as string).length)));
  const lines = table.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] as number))).join("  ").trimEnd());
  lines.push("", `Total: ${usd(result.storedUsd)} stored → ${usd(result.correctedUsd)} corrected (${result.rows.length} report${result.rows.length === 1 ? "" : "s"}).`);
  const pending = result.rows.filter((r) => !r.applied);
  const heuristic = pending.filter((r) => r.evidence === "heuristic").length;
  if (!options.apply) {
    if (pending.length > 0) lines.push("Dry run: nothing was changed. Apply with `tide usage repair --apply` (add --include-heuristic to correct the rows without a transcript too).");
    else lines.push("Every row is already corrected.");
  } else {
    lines.push(`Corrected ${result.appliedCount} report${result.appliedCount === 1 ? "" : "s"}.`);
    if (heuristic > 0 && !options.includeHeuristic) lines.push(`${heuristic} heuristic row${heuristic === 1 ? " was" : "s were"} left alone; add --include-heuristic to correct ${heuristic === 1 ? "it" : "them"}.`);
  }
  return lines.join("\n");
}

/** `tide usage repair [--apply] [--include-heuristic]` */
export async function runUsageRepair(options: { apply: boolean; includeHeuristic: boolean }, call: LocalCall = localRpc()): Promise<string> {
  const result = (await call("usage.repair", { ...(options.apply ? { apply: true } : {}), ...(options.includeHeuristic ? { includeHeuristic: true } : {}) })) as UsageRepairResult;
  return repairText(result, options);
}
