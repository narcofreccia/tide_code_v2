/**
 * Manual check for the Bun pty backend, which cannot run under vitest (that process is
 * Node, so `Bun` is undefined and node-pty is selected instead).
 *
 *   TIDE_HOME=$(mktemp -d) bun apps/server/src/bin.ts --dev --port 3798
 *   TIDE_HOME=<same dir> node --experimental-strip-types apps/server/scripts/check-bun-pty.ts
 *
 * The checker itself runs under Node or Bun; only the *server* has to be Bun. It drives a
 * real `pty.create` + `pty.attach` round trip over the WS RPC and prints the backend it
 * exercised. Exits 0 on success, 1 with a reason otherwise.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PtyChunk, RpcFrame } from "@tide/contracts";

const PORT = Number(process.env["TIDE_PORT"] ?? process.argv[2] ?? 3798);
const HOST = process.env["TIDE_HOST"] ?? "127.0.0.1";
const TIDE_HOME = resolve(process.env["TIDE_HOME"] ?? join(homedir(), ".tide"));
const MARKER = "tide-bun-pty-ok";
const TIMEOUT_MS = 20_000;

function token(): string {
  const file = join(TIDE_HOME, "server.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { token?: string };
  if (typeof parsed.token !== "string") throw new Error(`${file} has no token`);
  return parsed.token;
}

class Client {
  #ws: WebSocket;
  #next = 0;
  #pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  #streams = new Map<string, (chunk: unknown) => void>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String((event as MessageEvent).data)) as RpcFrame;
      if ("chunk" in frame) {
        this.#streams.get(frame.id)?.(frame.chunk);
        return;
      }
      if ("end" in frame) return;
      const pending = this.#pending.get(frame.id);
      if (!pending) return;
      this.#pending.delete(frame.id);
      if ("error" in frame) pending.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
      else pending.resolve(frame.result);
    });
  }

  static open(url: string): Promise<Client> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => res(new Client(ws)));
      ws.addEventListener("error", () => rej(new Error(`cannot connect to ${url}`)));
      ws.addEventListener("close", (event) => rej(new Error(`socket closed (${(event as CloseEvent).code})`)));
    });
  }

  call<T>(method: string, params: unknown): Promise<T> {
    const id = `c${++this.#next}`;
    return new Promise<T>((res, rej) => {
      this.#pending.set(id, { resolve: res as (v: unknown) => void, reject: rej });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  subscribe(method: string, params: unknown, onChunk: (chunk: unknown) => void): void {
    const id = `s${++this.#next}`;
    this.#streams.set(id, onChunk);
    this.#ws.send(JSON.stringify({ id, method, params }));
  }

  close(): void {
    this.#ws.close();
  }
}

interface Dispatched {
  events: { event: { type: string; project?: { id: string }; thread?: { id: string } } }[];
}

async function main(): Promise<void> {
  const url = `ws://${HOST}:${PORT}/ws?token=${token()}`;
  const client = await Client.open(url);
  const project = await client.call<Dispatched>("orchestration.dispatch", {
    // a fresh root each run, so repeated checks against one TIDE_HOME never conflict
    command: { type: "project.create", title: "bun-pty-check", rootPath: mkdtempSync(join(tmpdir(), "tide-bun-pty-")) },
  });
  const projectId = project.events[0]?.event.project?.id;
  if (projectId === undefined) throw new Error("project.create returned no project");
  const thread = await client.call<Dispatched>("orchestration.dispatch", {
    command: { type: "thread.create", projectId, provider: "claude" },
  });
  const threadId = thread.events[0]?.event.thread?.id;
  if (threadId === undefined) throw new Error("thread.create returned no thread");

  const { ptyId } = await client.call<{ ptyId: string }>("pty.create", { threadId, cols: 80, rows: 24, shell: "/bin/sh" });

  let output = "";
  const sawMarker = withTimeout<void>("terminal output", (resolveOutput, _rejectOutput, sawExit) => {
    client.subscribe("pty.attach", { ptyId }, (chunk) => {
      const typed = chunk as PtyChunk;
      if (typed.kind === "data") {
        output += typed.data;
        if (output.includes(MARKER)) resolveOutput();
      } else sawExit(typed);
    });
  });

  await client.call("pty.write", { ptyId, data: `echo ${MARKER}\n` });
  await sawMarker.promise;

  await client.call("pty.resize", { ptyId, cols: 120, rows: 40 });
  const listed = await client.call<{ ptys: { ptyId: string; alive: boolean }[] }>("pty.list", { threadId });
  if (listed.ptys.find((p) => p.ptyId === ptyId)?.alive !== true) throw new Error("pty.list did not report the terminal alive");

  await client.call("pty.write", { ptyId, data: "exit\n" });
  const exit = await sawMarker.exit;

  // second terminal: exercises the backend's kill path, which `exit` does not
  const killed = await client.call<{ ptyId: string }>("pty.create", { threadId, cols: 40, rows: 10, shell: "/bin/sh" });
  const killExit = withTimeout<PtyChunk>("kill exit", (res, _rej, onExit) => {
    client.subscribe("pty.attach", { ptyId: killed.ptyId }, (chunk) => {
      const typed = chunk as PtyChunk;
      if (typed.kind === "exit") {
        onExit(typed);
        res(typed);
      }
    });
  });
  await client.call("pty.kill", { ptyId: killed.ptyId });
  const killedExit = await killExit.promise;

  client.close();
  console.log(`ok: bun pty round trip (marker seen, exit ${JSON.stringify(exit)}, kill ${JSON.stringify(killedExit)})`);
}

/** Resolves when the marker is seen; separately exposes the terminal's exit chunk. */
function withTimeout<T>(
  what: string,
  body: (resolve: (v: T) => void, reject: (e: unknown) => void, onExit: (chunk: PtyChunk) => void) => void,
): { promise: Promise<T>; exit: Promise<PtyChunk> } {
  let onExitResolve: (chunk: PtyChunk) => void = () => undefined;
  const exit = new Promise<PtyChunk>((res) => {
    onExitResolve = res;
  });
  const promise = new Promise<T>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), TIMEOUT_MS);
    body(
      (value) => {
        clearTimeout(timer);
        res(value);
      },
      rej,
      onExitResolve,
    );
  });
  return { promise, exit };
}

main().catch((err: unknown) => {
  console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
