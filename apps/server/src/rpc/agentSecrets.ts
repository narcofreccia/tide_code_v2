// R16: tide_request_secret. The agent asks for a secret through a masked card on its own turn;
// the user's value travels over `secret.provide` into this module's memory and is handed to
// the waiting tool call once. Events carry only `{ decided }`; the value is never logged.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId as defaultNewId, type ActivityOf, type ReadModel, type RpcInput, type RpcOutput } from "@tide/contracts";
import { CommandError, type Engine } from "../orchestration/engine.ts";
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
 * the waiting call taking it; `waiting` is the set of cards a tool call is blocked on.
 */
export function registerAgentSecretHandlers(router: RpcRouter, deps: AgentSecretDeps): void {
  const { engine } = deps;
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
}
