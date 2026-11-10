// R16: tide_request_secret. The agent asks for a secret through a masked card on its own turn;
// the user's value travels over `secret.provide` (a unary RPC, not a command) into this module's
// memory and is handed to the waiting tool call once. The card's events carry only `{ decided }`.
// The harness then echoes the tool result (and may repeat the value in commands or text): the
// value is remembered per thread in memory (`secretValuesFor`, R18) and the provider reactor
// redacts it from every command before it reaches the event log or a client. kind "file" writes
// `<TIDE_HOME>/secrets/<threadId>/<NAME>`; the directory is removed when the thread is archived or
// deleted, and directories of unknown threads are swept at boot.
import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId as defaultNewId, type ActivityOf, type ReadModel, type RpcInput, type RpcOutput } from "@tide/contracts";
import { CommandError, type Engine } from "../orchestration/engine.ts";
import { secretValuesFor } from "../provider/secretRedaction.ts";
import { callerThread, DEFAULT_WAIT_MS, type CancelTimer } from "./agentThreads.ts";
import { RpcException, type RpcRouter } from "./router.ts";

type SecretResult = RpcOutput<"agent.secret.request">;
type SecretRequest = RpcInput<"agent.secret.request">;

export interface AgentSecretDeps {
  engine: Engine;
  tideHome: string;
  /** timeout timer (tests pass a manual clock) */
  schedule?: (fn: () => void, ms: number) => CancelTimer;
  newId?: () => string;
}

const ACTIVE = new Set(["requested", "running"]);
const NAME = /^[A-Z0-9_]{1,64}$/;

const realTimer = (fn: () => void, ms: number): CancelTimer => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/** The pending secret card with this request id on the thread, if any. */
export function pendingSecret(model: ReadModel, threadId: string, requestId: string): ActivityOf<"user-input"> | undefined {
  const timeline = model.threadTimeline[threadId] ?? [];
  for (let i = timeline.length - 1; i >= 0; i--) {
    const entry = timeline[i];
    if (entry?.kind !== "activity") continue;
    const a = model.activities[entry.id];
    if (a?.kind === "user-input" && a.requestId === requestId && a.secret === true && a.status === "pending") return a;
  }
  return undefined;
}

/** `<tideHome>/secrets/<threadId>/<name>`, dir 0700, file 0600 (also when it already existed). */
export async function writeSecretFile(tideHome: string, threadId: string, name: string, value: string): Promise<string> {
  if (!NAME.test(name) || threadId.includes("/") || threadId.includes("..")) throw new RpcException("invalid-params", "bad secret name or thread");
  const root = join(tideHome, "secrets");
  const dir = join(root, threadId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await chmod(dir, 0o700);
  const path = join(dir, name);
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

const safeThreadId = (threadId: string): boolean => threadId !== "" && !threadId.includes("/") && !threadId.includes("\\") && !threadId.includes("..");

/** Removes `<tideHome>/secrets/<threadId>` (no-op when absent). */
export async function removeThreadSecrets(tideHome: string, threadId: string): Promise<void> {
  if (!safeThreadId(threadId)) return;
  await rm(join(tideHome, "secrets", threadId), { recursive: true, force: true });
}

/** Boot: removes the secret directories of threads that are gone or archived. */
export async function sweepSecretDirs(tideHome: string, model: ReadModel): Promise<string[]> {
  let names: string[];
  try {
    names = (await readdir(join(tideHome, "secrets"), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const stale = names.filter((name) => {
    const thread = model.threads[name];
    return thread === undefined || thread.archivedAt !== undefined;
  });
  for (const name of stale) await removeThreadSecrets(tideHome, name);
  return stale;
}

async function dispatch(engine: Engine, command: Parameters<Engine["dispatch"]>[0]): Promise<void> {
  try {
    await engine.dispatch(command);
  } catch (err) {
    if (err instanceof CommandError) throw new RpcException(err.code, err.message);
    throw err;
  }
}

/**
 * One instance per server: `values` holds a provided secret only between `secret.provide` and
 * the waiting call taking it; `waiting` is the set of cards a tool call is blocked on. A value
 * handed out is remembered for redaction until its thread is archived or deleted. The returned
 * `settled()` resolves when the boot sweep and every cleanup started so far are done (tests).
 */
export function registerAgentSecretHandlers(router: RpcRouter, deps: AgentSecretDeps): { settled(): Promise<void> } {
  const { engine } = deps;
  const handedOut = secretValuesFor(engine);
  const cleanups = new Set<Promise<unknown>>();
  const track = (work: Promise<unknown>): void => {
    const p: Promise<unknown> = work.catch(() => undefined).finally(() => cleanups.delete(p));
    cleanups.add(p);
  };
  track(sweepSecretDirs(deps.tideHome, engine.getModel()));
  engine.subscribe(({ event }) => {
    if (event.type !== "thread.archived" && event.type !== "thread.deleted") return;
    handedOut.forget(event.threadId);
    track(removeThreadSecrets(deps.tideHome, event.threadId));
  });
  const schedule = deps.schedule ?? realTimer;
  const mint = deps.newId ?? (() => defaultNewId());
  const values = new Map<string, string>();
  const waiting = new Set<string>();

  async function request(input: SecretRequest, threadId: string, turnId: string): Promise<SecretResult> {
    const requestId = `secret:${mint()}`;
    const now = Date.now();
    let off: (() => void) | undefined;
    let cancel: CancelTimer | undefined;
    const decided = new Promise<"provided" | "declined">((resolve) => {
      let finished = false;
      const finish = (d: "provided" | "declined"): void => {
        if (finished) return;
        finished = true;
        off?.();
        cancel?.();
        resolve(d);
      };
      off = engine.subscribe(({ event }) => {
        if (event.type === "user-input.responded" && event.threadId === threadId && event.requestId === requestId) {
          finish(event.answers["decided"] === "provided" ? "provided" : "declined");
        } else if (event.type === "turn.settled" && event.turnId === turnId) {
          // the projector already resolved the card with its turn
          finish("declined");
        }
      });
      cancel = schedule(() => {
        // close the card; the respond event (or its failure) ends the wait either way
        engine
          .dispatch({ type: "user-input.respond", threadId, requestId, answers: { decided: "declined" } })
          .catch(() => undefined)
          .finally(() => finish("declined"));
      }, input.timeoutMs ?? DEFAULT_WAIT_MS);
    });
    waiting.add(requestId);
    try {
      await dispatch(engine, {
        type: "activity.upsert",
        activity: {
          id: mint(),
          threadId,
          turnId,
          kind: "user-input",
          secret: true,
          requestId,
          questions: [{ id: input.name, text: input.purpose }],
          status: "pending",
          createdAt: now,
          updatedAt: now,
        },
      });
    } catch (err) {
      off?.();
      cancel?.();
      waiting.delete(requestId);
      throw err;
    }
    const outcome = await decided;
    waiting.delete(requestId);
    const value = values.get(requestId);
    values.delete(requestId);
    if (outcome !== "provided" || value === undefined) return { decided: "declined" };
    // remembered before the harness can echo it (a "file" value can still be read back and printed)
    handedOut.remember(threadId, value);
    if (input.kind === "file") return { decided: "provided", path: await writeSecretFile(deps.tideHome, threadId, input.name, value) };
    return { decided: "provided", value };
  }

  router.register("agent.secret.request", async (input, ctx) => {
    const model = engine.getModel();
    const caller = callerThread(model, ctx);
    const turn = caller.latestTurnId === undefined ? undefined : model.turns[caller.latestTurnId];
    if (!turn || !ACTIVE.has(turn.status)) throw new RpcException("conflict", `thread ${caller.id} has no active turn to ask on`);
    return request(input, caller.id, turn.id);
  });

  router.register("secret.provide", async (input) => {
    const card = pendingSecret(engine.getModel(), input.threadId, input.requestId);
    if (!card || !waiting.has(input.requestId)) throw new RpcException("not-found", `no pending secret request ${input.requestId}`);
    values.set(input.requestId, input.value);
    try {
      await dispatch(engine, { type: "user-input.respond", threadId: input.threadId, requestId: input.requestId, answers: { decided: "provided" } });
    } catch (err) {
      values.delete(input.requestId);
      throw err;
    }
    return { ok: true };
  });

  return {
    async settled() {
      while (cleanups.size > 0) await Promise.all([...cleanups]);
    },
  };
}
