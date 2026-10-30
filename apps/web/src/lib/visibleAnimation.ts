/**
 * Pauses decorative loops nobody can see. Every observed element carries
 * `--visible-animation-state: running | paused` (feed it to
 * `animation-play-state`): running only while the element intersects the
 * viewport, the tab is visible, and the user has not asked for reduced motion
 * or forced colours. One IntersectionObserver and one visibilitychange listener
 * serve every element; both go away with the last one.
 */

const PROPERTY = "--visible-animation-state";
const STILL = "(prefers-reduced-motion: reduce), (forced-colors: active)";

const onScreen = new Map<HTMLElement, boolean>();
let observer: IntersectionObserver | undefined;
let listening = false;

function prefersStill(): boolean {
  return typeof matchMedia === "function" && matchMedia(STILL).matches;
}

function tabVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function apply(el: HTMLElement): void {
  const running = (onScreen.get(el) ?? false) && tabVisible() && !prefersStill();
  el.style.setProperty(PROPERTY, running ? "running" : "paused");
}

function applyAll(): void {
  for (const el of onScreen.keys()) apply(el);
}

function ensureWatching(): void {
  if (!listening && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", applyAll);
    listening = true;
  }
  if (observer === undefined && typeof IntersectionObserver === "function") {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        if (!onScreen.has(el)) continue;
        onScreen.set(el, entry.isIntersecting);
        apply(el);
      }
    });
  }
}

function stopWatching(): void {
  observer?.disconnect();
  observer = undefined;
  if (listening) document.removeEventListener("visibilitychange", applyAll);
  listening = false;
}

/**
 * Ref-callback friendly: `<span ref={observeVisibleAnimation}>` (React 19 runs
 * the returned cleanup on unmount). Without IntersectionObserver the element
 * counts as on screen.
 */
export function observeVisibleAnimation(el: HTMLElement | null): () => void {
  if (el === null) return () => undefined;
  ensureWatching();
  // paused until the observer's first report; on screen at once when there is no observer
  onScreen.set(el, observer === undefined);
  apply(el);
  observer?.observe(el);
  return () => {
    observer?.unobserve(el);
    onScreen.delete(el);
    if (onScreen.size === 0) stopWatching();
  };
}
