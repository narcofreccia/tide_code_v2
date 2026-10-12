import { useEffect } from "react";
import { useUi } from "../state/ui.ts";
import { formatRoute, parseRoute, routeOf, type Route } from "./route.ts";

/**
 * Puts a route on screen. A thread or session that has not loaded yet is still
 * selected: the content area falls back to Mission Control until it exists.
 */
export function applyRoute(route: Route): void {
  const ui = useUi.getState();
  switch (route.view) {
    case "mission":
      useUi.setState({ view: "mission" });
      return;
    case "thread":
      useUi.setState({ selectedThreadId: route.threadId, view: "thread" });
      return;
    case "experts":
      ui.selectExpertsSession(route.sessionId);
      return;
    case "threads":
      ui.showAllThreads(route.projectId);
      return;
    case "settings":
      ui.setSettingsSection(route.section);
      ui.showSettings();
      return;
  }
}

function currentHash(): string {
  return formatRoute(routeOf(useUi.getState()));
}

/**
 * Two-way sync between the ui store and `location.hash`, no router library.
 * Store changes push a history entry (so Back works); `hashchange`/`popstate`
 * (Back, a pasted link) apply the route. On mount the hash wins, so a reload
 * restores the view; an empty hash is filled in without a history entry.
 */
export function useHashRoute(): void {
  useEffect(() => {
    const fromLocation = (): void => {
      const route = parseRoute(window.location.hash);
      if (route && formatRoute(route) !== currentHash()) applyRoute(route);
    };

    const initial = parseRoute(window.location.hash);
    if (initial) applyRoute(initial);
    else window.history.replaceState(null, "", currentHash());

    const unsubscribe = useUi.subscribe(() => {
      const next = currentHash();
      if (next !== window.location.hash) window.history.pushState(null, "", next);
    });
    window.addEventListener("hashchange", fromLocation);
    window.addEventListener("popstate", fromLocation);
    return () => {
      unsubscribe();
      window.removeEventListener("hashchange", fromLocation);
      window.removeEventListener("popstate", fromLocation);
      // the store already holds the route; a remount (StrictMode, tests) must not
      // replay a stale hash over a newer selection
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    };
  }, []);
}
