import type { EnvProbe, EnvRoute } from "@tide/contracts";
import { httpOriginFor } from "./urls.ts";

/** The slice of `fetch` the environment layer needs; injectable for tests and non-browser hosts. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<FetchResponseLike>;

export const defaultFetch: FetchLike = (url, init) =>
  (globalThis as unknown as { fetch: FetchLike }).fetch(url, init);

export type PreflightResult =
  | { kind: "ok"; probe: EnvProbe }
  /** answered over HTTP but not with an EnvProbe (a server older than R9, a proxy page) */
  | { kind: "unknown"; status: number }
  | { kind: "unreachable"; error: string };

export interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isProbe(body: unknown): body is EnvProbe {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return typeof b.environmentId === "string" && typeof b.name === "string";
}

/** `GET <route origin>/api/env` (no auth) with a deadline: who answers on this route, if anyone. */
export async function preflight(
  route: EnvRoute,
  fetchImpl: FetchLike = defaultFetch,
  timeoutMs = 2000,
  timers: Timers = realTimers,
): Promise<PreflightResult> {
  const controller = typeof AbortController === "undefined" ? undefined : new AbortController();
  let handle: unknown;
  const deadline = new Promise<PreflightResult>((resolve) => {
    handle = timers.setTimeout(() => {
      controller?.abort();
      resolve({ kind: "unreachable", error: "timed out" });
    }, timeoutMs);
  });
  const attempt = (async (): Promise<PreflightResult> => {
    try {
      const res = await fetchImpl(`${httpOriginFor(route.url)}/api/env`, {
        method: "GET",
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!res.ok) return { kind: "unknown", status: res.status };
      const body = await res.json().catch(() => undefined);
      return isProbe(body) ? { kind: "ok", probe: body } : { kind: "unknown", status: res.status };
    } catch (err) {
      return { kind: "unreachable", error: errorMessage(err) };
    }
  })();
  try {
    return await Promise.race([attempt, deadline]);
  } finally {
    timers.clearTimeout(handle);
  }
}

export class UnauthorizedError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * Production auth: the raw token never travels on the WebSocket URL. It buys a single-use
 * ticket over HTTP(S) on the route's own origin; 401/403 means the token itself is wrong.
 */
export function ticketGetter(httpOrigin: string, token: string, fetchImpl: FetchLike = defaultFetch): () => Promise<string> {
  return async () => {
    const response = await fetchImpl(`${httpOrigin}/api/auth/ws-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    if (response.status === 401 || response.status === 403) throw new UnauthorizedError(`ws-ticket refused: ${response.status}`);
    if (!response.ok) throw new Error(`ws-ticket failed: ${response.status}`);
    const body = (await response.json()) as { ticket?: string };
    if (!body.ticket) throw new Error("ws-ticket response had no ticket");
    return body.ticket;
  };
}
