import { describe, expect, it } from "vitest";
import { formatRoute, parseRoute, routeOf, type RoutedUi } from "./route.ts";

describe("parseRoute / formatRoute", () => {
  it("round-trips every view", () => {
    for (const hash of [
      "#/mission",
      "#/thread/t1",
      "#/experts/x1",
      "#/settings/decisions",
      "#/threads/p1",
    ]) {
      const route = parseRoute(hash);
      expect(route).toBeDefined();
      expect(formatRoute(route!)).toBe(hash);
    }
  });

  it("encodes ids that carry separators", () => {
    const hash = formatRoute({ view: "thread", threadId: "a/b c" });
    expect(hash).toBe("#/thread/a%2Fb%20c");
    expect(parseRoute(hash)).toEqual({ view: "thread", threadId: "a/b c" });
  });

  it("defaults a bare #/settings to Providers", () => {
    expect(parseRoute("#/settings")).toEqual({ view: "settings", section: "providers" });
  });

  it("ignores empty, unknown and incomplete hashes", () => {
    expect(parseRoute("")).toBeUndefined();
    expect(parseRoute("#")).toBeUndefined();
    expect(parseRoute("#/nope")).toBeUndefined();
    expect(parseRoute("#/thread")).toBeUndefined();
    expect(parseRoute("#/settings/bogus")).toBeUndefined();
  });
});

describe("routeOf", () => {
  const base: RoutedUi = {
    view: "mission",
    selectedThreadId: null,
    selectedExpertsSessionId: null,
    allThreadsProjectId: null,
    settingsSection: "git",
  };

  it("derives the route from the ui store", () => {
    expect(routeOf(base)).toEqual({ view: "mission" });
    expect(routeOf({ ...base, view: "thread", selectedThreadId: "t1" })).toEqual({ view: "thread", threadId: "t1" });
    expect(routeOf({ ...base, view: "settings" })).toEqual({ view: "settings", section: "git" });
    expect(routeOf({ ...base, view: "threads", allThreadsProjectId: "p1" })).toEqual({ view: "threads", projectId: "p1" });
    expect(routeOf({ ...base, view: "experts", selectedExpertsSessionId: "x1" })).toEqual({
      view: "experts",
      sessionId: "x1",
    });
  });

  it("falls back to Mission Control when the view has no id", () => {
    expect(routeOf({ ...base, view: "thread" })).toEqual({ view: "mission" });
    expect(routeOf({ ...base, view: "experts" })).toEqual({ view: "mission" });
  });
});
