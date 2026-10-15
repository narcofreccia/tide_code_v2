import { jsonSafe, type Recorder } from "./recorder.ts";
import type { Replay, ReplayTransport } from "./transport.ts";

/**
 * HTTP transport (OpenCode): a `fetch` replacement.
 *
 *   expect_out.match  { method, path, body? }          path includes the query string
 *   in.frame          { status, body?, headers? }       the response to that request
 *                     { status, stream: true }          ... or an open SSE response, followed by
 *                     { sse: <event json> }             one `data:` frame per event
 *                     { sseRaw: "<raw text>" }          ... raw SSE text (comments, multi-line data)
 *                     { sseEnd: true }                  the server closes the stream
 *
 * The whole transcript is one connection (process 0); the origin is ignored when matching.
 */

export interface HttpRequestFrame {
  method: string;
  path: string;
  body?: unknown;
}

interface ResponseFrame {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  stream?: boolean;
  sse?: unknown;
  sseRaw?: string;
  sseEnd?: boolean;
}

export type FetchImpl = typeof fetch;

export function requestFrame(input: Parameters<FetchImpl>[0], init: Parameters<FetchImpl>[1]): HttpRequestFrame {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw, "http://replay.invalid");
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const frame: HttpRequestFrame = { method, path: `${url.pathname}${url.search}` };
  const body = init?.body;
  if (typeof body === "string" && body !== "") {
    try {
      frame.body = JSON.parse(body);
    } catch {
      frame.body = body;
    }
  }
  return frame;
}

export interface ReplayFetch {
  fetch: FetchImpl;
  transport: ReplayTransport;
  /** every request frame the driver made, oldest first */
  readonly requests: HttpRequestFrame[];
}

export function replayFetch(replay: Replay): ReplayFetch {
  const transport = replay.only();
  const requests: HttpRequestFrame[] = [];
  const encoder = new TextEncoder();
  let pending: { resolve: (response: Response) => void } | undefined;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let streamClosed = true;

  const closeStream = (): void => {
    if (stream && !streamClosed) {
      streamClosed = true;
      try {
        stream.close();
      } catch {
        // already closed
      }
    }
  };

  transport.attach({
    deliver: (raw) => {
      const frame = (raw ?? {}) as ResponseFrame;
      if (frame.sse !== undefined || frame.sseRaw !== undefined || frame.sseEnd === true) {
        if (!stream || streamClosed) throw new Error("replay: an SSE frame arrived but no event stream is open");
        if (frame.sseEnd === true) closeStream();
        else stream.enqueue(encoder.encode(frame.sseRaw ?? `data: ${JSON.stringify(frame.sse)}\n\n`));
        return;
      }
      const waiting = pending;
      if (!waiting) throw new Error(`replay: a response frame arrived with no request waiting: ${JSON.stringify(raw)}`);
      pending = undefined;
      const status = frame.status ?? 200;
      if (frame.stream === true) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            streamClosed = false;
          },
        });
        waiting.resolve(new Response(body, { status, headers: { "content-type": "text/event-stream", ...frame.headers } }));
        return;
      }
      const hasBody = frame.body !== undefined && status !== 204 && status !== 304;
      waiting.resolve(
        new Response(hasBody ? (typeof frame.body === "string" ? frame.body : JSON.stringify(frame.body)) : null, {
          status,
          headers: { ...(hasBody && typeof frame.body !== "string" ? { "content-type": "application/json" } : {}), ...frame.headers },
        }),
      );
    },
    exit: () => closeStream(),
  });

  const replayFetchImpl: FetchImpl = (input, init) =>
    new Promise<Response>((resolve, reject) => {
      const frame = requestFrame(input, init);
      requests.push(frame);
      const signal = init?.signal;
      if (signal) {
        if (signal.aborted) {
          reject(signal.reason ?? new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", closeStream, { once: true });
      }
      pending = { resolve };
      try {
        transport.write(frame);
      } catch (error) {
        pending = undefined;
        reject(error);
        return;
      }
      if (pending !== undefined) {
        pending = undefined;
        const error = new Error(`replay: the transcript has no response for ${frame.method} ${frame.path}`);
        reject(error);
      }
    });
  return { fetch: replayFetchImpl, transport, requests };
}

// ---- recording ----

function sseFrames(text: string): unknown[] {
  const events: unknown[] = [];
  for (const block of text.split(/\n\n/)) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data === "") continue;
    try {
      events.push({ sse: JSON.parse(data) });
    } catch {
      events.push({ sseRaw: `${block}\n\n` });
    }
  }
  return events;
}

/** Wraps a real `fetch`: requests become `expect_out`, responses `in` (SSE bodies are tapped chunk by chunk). */
export function recordFetch(real: FetchImpl, recorder: Recorder): FetchImpl {
  let started = false;
  return async (input, init) => {
    if (!started) {
      started = true;
      recorder.proc();
    }
    recorder.out(jsonSafe(requestFrame(input, init)));
    const response = await real(input, init);
    const type = response.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream") && response.body) {
      recorder.in({ status: response.status, stream: true });
      const [forDriver, forTap] = response.body.tee();
      void (async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          for await (const chunk of forTap as unknown as AsyncIterable<Uint8Array>) {
            buffer += decoder.decode(chunk, { stream: true });
            const cut = buffer.lastIndexOf("\n\n");
            if (cut < 0) continue;
            for (const frame of sseFrames(buffer.slice(0, cut + 2))) recorder.in(frame);
            buffer = buffer.slice(cut + 2);
          }
        } catch {
          // aborted by the driver: the stream is simply over
        }
        recorder.in({ sseEnd: true });
      })();
      return new Response(forDriver, { status: response.status, headers: response.headers });
    }
    const text = await response.clone().text();
    let body: unknown;
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    recorder.in({ status: response.status, ...(body !== undefined ? { body } : {}) });
    return response;
  };
}
