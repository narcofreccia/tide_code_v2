import { jsonSafe, type Recorder } from "./recorder.ts";
import type { Replay } from "./transport.ts";

/**
 * SDK transport (Claude Agent SDK `query()`): the SDK is the wire, so the frames are its calls.
 *
 *   expect_out.match  { kind: "query", options }          the `query()` call (options without env)
 *                     { kind: "prompt", message }         each message the driver feeds the prompt stream
 *                     { kind: "control", method, args }   interrupt / setModel / setPermissionMode / ...
 *                     { kind: "permission", toolName, result }   the answer to a `canUseTool` callback
 *   in.frame          an SDK message, yielded by the iterator
 *                     { callback: "canUseTool", toolName, input, toolUseID }   invokes options.canUseTool
 *                     { control_result: <value> }          the return value of the pending control call
 *
 * One `query()` call is one process of the transcript.
 */

interface QueryParams {
  prompt: AsyncIterable<unknown> | string;
  options?: Record<string, unknown>;
}

interface QueryShape extends AsyncIterable<unknown> {
  interrupt: () => Promise<void>;
  setPermissionMode: (mode: string) => Promise<void>;
  setModel: (model?: string) => Promise<void>;
  supportedModels: () => Promise<unknown[]>;
  getContextUsage: () => Promise<unknown>;
}

export type ReplayQueryFn = ((params: QueryParams) => QueryShape) & { readonly calls: QueryParams[] };

/** Options with everything unserialisable or secret removed: what a transcript can say about a call. */
export function queryOptionsFrame(options: Record<string, unknown> | undefined): unknown {
  const { env: _env, abortController: _abort, stderr: _stderr, canUseTool, ...rest } = options ?? {};
  return { ...(jsonSafe(rest) as object), ...(typeof canUseTool === "function" ? { canUseTool: true } : {}) };
}

class Mailbox<T> {
  #items: T[] = [];
  #waiting: { resolve: (value: IteratorResult<T>) => void; reject: (error: unknown) => void } | undefined;
  #done = false;
  #error: unknown;

  push(item: T): void {
    if (this.#waiting) {
      const waiting = this.#waiting;
      this.#waiting = undefined;
      waiting.resolve({ value: item, done: false });
    } else this.#items.push(item);
  }

  end(): void {
    this.#done = true;
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.resolve({ value: undefined, done: true });
  }

  fail(error: unknown): void {
    this.#error ??= error;
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.reject(error);
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.#error !== undefined) return Promise.reject(this.#error);
    if (this.#done) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => {
      this.#waiting = { resolve, reject };
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function replayQuery(replay: Replay): ReplayQueryFn {
  const calls: QueryParams[] = [];
  const queryFn = (params: QueryParams): QueryShape => {
    calls.push(params);
    const transport = replay.next();
    const mailbox = new Mailbox<unknown>();
    let control: ((value: unknown) => void) | undefined;

    const write = (frame: unknown): void => {
      try {
        transport.write(frame);
      } catch (error) {
        mailbox.fail(error);
        throw error;
      }
    };

    transport.attach({
      deliver: (frame) => {
        if (isRecord(frame) && frame["callback"] === "canUseTool") {
          const callback = params.options?.["canUseTool"];
          if (typeof callback !== "function") throw new Error("replay: the transcript calls canUseTool but the driver passed none");
          const toolName = String(frame["toolName"]);
          void (callback as (name: string, input: unknown, context: unknown) => Promise<unknown>)(toolName, frame["input"] ?? {}, { toolUseID: frame["toolUseID"] }).then(
            (result) => write({ kind: "permission", toolName, result: jsonSafe(result) }),
            (error: unknown) => mailbox.fail(error),
          );
          return;
        }
        if (isRecord(frame) && "control_result" in frame) {
          const resolve = control;
          control = undefined;
          resolve?.(frame["control_result"]);
          return;
        }
        mailbox.push(frame);
      },
      exit: (code) => {
        if (code === 0 || code === null) mailbox.end();
        else mailbox.fail(new Error(`claude process exited with code ${code}`));
      },
    });

    write({ kind: "query", options: queryOptionsFrame(params.options) });
    void (async () => {
      try {
        if (typeof params.prompt === "string") write({ kind: "prompt", message: params.prompt });
        else for await (const message of params.prompt) write({ kind: "prompt", message: jsonSafe(message) });
      } catch {
        // a mismatch is already in transport.errors and has failed the mailbox
      }
    })();

    const call = <T>(method: string, args: unknown[]): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        control = (value) => resolve(value as T);
        try {
          write({ kind: "control", method, args: jsonSafe(args) });
        } catch (error) {
          reject(error);
          return;
        }
        if (control !== undefined) {
          control = undefined;
          resolve(undefined as T);
        }
      });

    return {
      [Symbol.asyncIterator]: () => ({ next: () => mailbox.next() }),
      interrupt: () => call<void>("interrupt", []),
      setPermissionMode: (mode) => call<void>("setPermissionMode", [mode]),
      setModel: (model) => call<void>("setModel", [model]),
      supportedModels: async () => (await call<unknown[] | undefined>("supportedModels", [])) ?? [],
      getContextUsage: () => call<unknown>("getContextUsage", []),
    };
  };
  return Object.assign(queryFn, { calls });
}

// ---- recording ----

type RealQuery = (params: QueryParams) => AsyncIterable<unknown> & Partial<Omit<QueryShape, typeof Symbol.asyncIterator>>;

/** Wraps the real `query()`: the call, each prompt message, every control call and every yielded message are recorded. */
export function recordQuery(real: RealQuery, recorder: Recorder): RealQuery {
  return (params) => {
    recorder.proc();
    recorder.out({ kind: "query", options: queryOptionsFrame(params.options) });
    const options = params.options;
    const canUseTool = options?.["canUseTool"];
    const wrapped: Record<string, unknown> | undefined =
      typeof canUseTool === "function" && options
        ? {
            ...options,
            canUseTool: async (toolName: string, input: unknown, context: unknown) => {
              recorder.in({ callback: "canUseTool", toolName, input, toolUseID: (context as { toolUseID?: string } | undefined)?.toolUseID });
              const result = await (canUseTool as (a: string, b: unknown, c: unknown) => Promise<unknown>)(toolName, input, context);
              recorder.out({ kind: "permission", toolName, result: jsonSafe(result) });
              return result;
            },
          }
        : options;

    let prompt = params.prompt;
    if (typeof prompt === "string") recorder.out({ kind: "prompt", message: prompt });
    else {
      const source = prompt;
      prompt = (async function* () {
        for await (const message of source) {
          recorder.out({ kind: "prompt", message: jsonSafe(message) });
          yield message;
        }
      })();
    }

    const query = real({ prompt, ...(wrapped ? { options: wrapped } : {}) });
    const record = (method: string): ((...args: unknown[]) => Promise<unknown>) | undefined => {
      const target = (query as unknown as Record<string, unknown>)[method];
      if (typeof target !== "function") return undefined;
      return async (...args: unknown[]) => {
        recorder.out({ kind: "control", method, args: jsonSafe(args) });
        const value = await (target as (...a: unknown[]) => Promise<unknown>).apply(query, args);
        if (value !== undefined) recorder.in({ control_result: jsonSafe(value) });
        return value;
      };
    };
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const message of query) {
            recorder.in(jsonSafe(message));
            yield message;
          }
        } catch (error) {
          recorder.exit(1);
          throw error;
        }
        recorder.exit(0);
      },
      ...(["interrupt", "setPermissionMode", "setModel", "supportedModels", "getContextUsage"] as const).reduce(
        (all, method) => {
          const wrap = record(method);
          return wrap ? { ...all, [method]: wrap } : all;
        },
        {} as Record<string, unknown>,
      ),
    } as ReturnType<RealQuery>;
  };
}
