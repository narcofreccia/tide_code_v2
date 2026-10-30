import { SETTINGS_SECTIONS, type SettingsSection, type View } from "../state/ui.ts";

/** What the address bar says: one view and the id it is about. */
export type Route =
  | { view: "mission" }
  | { view: "thread"; threadId: string }
  | { view: "experts"; sessionId: string }
  | { view: "settings"; section: SettingsSection }
  | { view: "threads"; projectId: string }
  | { view: "prs"; projectId?: string }
  | { view: "usage" };

const MISSION: Route = { view: "mission" };

function isSection(value: string): value is SettingsSection {
  return (SETTINGS_SECTIONS as string[]).includes(value);
}

/**
 * `#/thread/<id>` → `{ view: "thread", threadId }`. Unknown or malformed hashes
 * return undefined so the caller keeps whatever is on screen.
 */
export function parseRoute(hash: string): Route | undefined {
  const path = hash.replace(/^#\/?/, "");
  if (path === "") return undefined;
  const [head = "", ...rest] = path.split("/");
  const id = rest.length > 0 ? decodeURIComponent(rest.join("/")) : "";
  switch (head) {
    case "mission":
      return MISSION;
    case "thread":
      return id === "" ? undefined : { view: "thread", threadId: id };
    case "experts":
      return id === "" ? undefined : { view: "experts", sessionId: id };
    case "threads":
      return id === "" ? undefined : { view: "threads", projectId: id };
    case "prs":
      return id === "" ? { view: "prs" } : { view: "prs", projectId: id };
    case "usage":
      return { view: "usage" };
    case "settings":
      if (id === "") return { view: "settings", section: "providers" };
      return isSection(id) ? { view: "settings", section: id } : undefined;
    default:
      return undefined;
  }
}

export function formatRoute(route: Route): string {
  switch (route.view) {
    case "mission":
      return "#/mission";
    case "thread":
      return `#/thread/${encodeURIComponent(route.threadId)}`;
    case "experts":
      return `#/experts/${encodeURIComponent(route.sessionId)}`;
    case "threads":
      return `#/threads/${encodeURIComponent(route.projectId)}`;
    case "prs":
      return route.projectId === undefined ? "#/prs" : `#/prs/${encodeURIComponent(route.projectId)}`;
    case "usage":
      return "#/usage";
    case "settings":
      return `#/settings/${route.section}`;
  }
}

/** The slice of the ui store a route is derived from. */
export interface RoutedUi {
  view: View;
  selectedThreadId: string | null;
  selectedExpertsSessionId: string | null;
  allThreadsProjectId: string | null;
  prsProjectId: string | null;
  settingsSection: SettingsSection;
}

/** The route the ui is showing; a view missing its id reads as Mission Control. */
export function routeOf(ui: RoutedUi): Route {
  switch (ui.view) {
    case "thread":
      return ui.selectedThreadId ? { view: "thread", threadId: ui.selectedThreadId } : MISSION;
    case "experts":
      return ui.selectedExpertsSessionId ? { view: "experts", sessionId: ui.selectedExpertsSessionId } : MISSION;
    case "threads":
      return ui.allThreadsProjectId ? { view: "threads", projectId: ui.allThreadsProjectId } : MISSION;
    case "prs":
      return ui.prsProjectId ? { view: "prs", projectId: ui.prsProjectId } : { view: "prs" };
    case "usage":
      return { view: "usage" };
    case "settings":
      return { view: "settings", section: ui.settingsSection };
    default:
      return MISSION;
  }
}
