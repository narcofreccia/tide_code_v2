import { cacheName, isStaleCache, strategyFor } from "./policy.ts";

declare const __BUILD_ID__: string;

/** Minimal worker-scope surface: the app tsconfig carries DOM, not WebWorker, types. */
interface FetchEventLike extends Event {
  request: Request;
  respondWith(response: Promise<Response>): void;
}
interface ExtendableEventLike extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface WorkerScope {
  location: Location;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: "install" | "activate", fn: (e: ExtendableEventLike) => void): void;
  addEventListener(type: "fetch", fn: (e: FetchEventLike) => void): void;
}

const scope = self as unknown as WorkerScope;
const CACHE = cacheName(__BUILD_ID__);

scope.addEventListener("install", (event) => {
  // activate immediately; the page toasts "new version, reload" on controllerchange
  event.waitUntil(scope.skipWaiting());
});

scope.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => isStaleCache(n, CACHE)).map((n) => caches.delete(n))))
      .then(() => scope.clients.claim()),
  );
});

async function store(request: Request, response: Response): Promise<void> {
  if (!response.ok) return;
  const cache = await caches.open(CACHE);
  await cache.put(request, response);
}

scope.addEventListener("fetch", (event) => {
  const { request } = event;
  const kind = strategyFor(new URL(request.url), request.method, scope.location.origin);
  if (kind === "bypass") return;
  if (kind === "cache-first") {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((res) => {
            void store(request, res.clone());
            return res;
          }),
      ),
    );
    return;
  }
  event.respondWith(
    fetch(request)
      .then((res) => {
        void store(request.mode === "navigate" ? new Request("/") : request, res.clone());
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(request.mode === "navigate" ? "/" : request);
        return hit ?? Response.error();
      }),
  );
});
