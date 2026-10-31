import type { Project, RunRepo, RunService, RunServiceState, RunSession } from "@tide/contracts";

/** One service of a project's stack, flattened across its repos (root + links). */
export interface StackService {
  /** `<repoKey>.<serviceId>` — the key `RunStack.selected`, plans and sessions use */
  key: string;
  repoId: string;
  repoKey: string;
  repoLabel: string;
  service: RunService;
  selected: boolean;
}

export function serviceKey(repoKey: string, serviceId: string): string {
  return `${repoKey}.${serviceId}`;
}

/** What "Start stack" starts: the project's saved selection, else every service not marked `default: false`. */
export function stackServices(repos: readonly RunRepo[], project: Pick<Project, "runStack"> | undefined): StackService[] {
  const selected = project?.runStack === undefined ? undefined : new Set(project.runStack.selected);
  const out: StackService[] = [];
  for (const repo of repos) {
    const profile = repo.profile;
    if (!profile) continue;
    const repoKey = profile.repoKey;
    for (const service of profile.services) {
      const key = serviceKey(repoKey, service.id);
      out.push({
        key,
        repoId: repo.repoId,
        repoKey,
        repoLabel: repo.label,
        service,
        selected: selected === undefined ? service.default !== false : selected.has(key),
      });
    }
  }
  return out;
}

/** worst first */
const SEVERITY: Record<RunServiceState, number> = {
  failed: 5,
  starting: 4,
  exited: 3,
  external: 2,
  ready: 1,
  running: 0,
};

export function isUp(state: RunServiceState): boolean {
  return state === "running" || state === "ready" || state === "external";
}

export interface RunSummary {
  up: number;
  total: number;
  /** the most severe service state; undefined when nothing runs */
  worst: RunServiceState | undefined;
}

/** "3/5 up": services of the session (plus planned, unblocked rows not reported yet) and the worst state. */
export function runSummary(session: RunSession | undefined): RunSummary {
  if (!session) return { up: 0, total: 0, worst: undefined };
  let up = 0;
  let worst: RunServiceState | undefined;
  const keys = new Set(Object.keys(session.services));
  for (const status of Object.values(session.services)) {
    if (isUp(status.state)) up += 1;
    if (worst === undefined || SEVERITY[status.state] > SEVERITY[worst]) worst = status.state;
  }
  for (const row of session.plan?.rows ?? []) if (row.blocked === undefined) keys.add(row.key);
  return { up, total: keys.size, worst };
}

/** listen names a browser can open, best first; `hmr`/`ws`/`sync` are not pages */
const PAGE_LISTENS = ["http", "web", "app", "dev"];
const NOT_PAGES = new Set(["hmr", "ws", "sync"]);

/** The port to open in the Preview tab: an http-ish listen, else the first that is not a socket. */
export function previewPort(ports: Readonly<Record<string, number>>): number | undefined {
  for (const name of PAGE_LISTENS) if (ports[name] !== undefined) return ports[name];
  for (const [name, port] of Object.entries(ports)) if (!NOT_PAGES.has(name)) return port;
  return undefined;
}
