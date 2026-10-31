import { join } from "node:path";
import type { RunConflict, RunListen, RunPlan, RunPlanRow, RunRepo, RunService } from "@tide/contracts";
import { parseKey, serviceKey as serviceKeyOf } from "./keys.ts";

/** listen key from a service key (`<repoKey>.<serviceId>` + `.<listen>`), see keys.ts */
const listenKeyOf = (service: string, listen: string): string => `${service}.${listen}`;

export interface PlanInput {
  repos: RunRepo[];
  /** service keys in the stack */
  selected: string[];
  /** listen key → port */
  pins: Record<string, number>;
  /** every listener on the host right now */
  listening: { port: number; pid: number; command: string }[];
  /** ports held by this project's own running session: not "busy" for the plan */
  ownPorts: Set<number>;
  /** substituted for `${host}` in connect templates */
  host: string;
  now: number;
}

interface Svc {
  key: string;
  repo: RunRepo;
  repoKey: string;
  service: RunService;
}

/** Every service of every loaded repo, in natural order (repo order, then profile order). */
function allServices(repos: RunRepo[]): Svc[] {
  const out: Svc[] = [];
  for (const repo of repos) {
    if (repo.profile === undefined || repo.error !== undefined) continue;
    for (const service of repo.profile.services) out.push({ key: serviceKeyOf(repo.repoKey, service.id), repo, repoKey: repo.repoKey, service });
  }
  return out;
}

/** Kahn's algorithm over `dependsOn` (same repo only), stable in natural order; a cycle keeps natural order. */
function topoOrder(svcs: Svc[], warnings: string[]): Svc[] {
  const byKey = new Map(svcs.map((s) => [s.key, s]));
  const deps = new Map<string, string[]>();
  for (const s of svcs) {
    const list: string[] = [];
    for (const id of s.service.dependsOn ?? []) {
      const dep = serviceKeyOf(s.repoKey, id);
      if (byKey.has(dep)) list.push(dep);
    }
    deps.set(s.key, list);
  }
  const done = new Set<string>();
  const out: Svc[] = [];
  while (out.length < svcs.length) {
    const next = svcs.find((s) => !done.has(s.key) && (deps.get(s.key) ?? []).every((d) => done.has(d)));
    if (next === undefined) {
      const rest = svcs.filter((s) => !done.has(s.key));
      warnings.push(`dependency cycle between ${rest.map((s) => s.key).join(", ")}; starting them in profile order`);
      out.push(...rest);
      break;
    }
    done.add(next.key);
    out.push(next);
  }
  return out;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Appends the port flag the way the listen wants it, replacing one already in the command. */
export function withPortFlag(command: string, listen: RunListen, port: number): string {
  let cmd = command;
  const flag = listen.flag ?? "--port";
  cmd = cmd.replace(new RegExp(`\\s${escapeRe(flag)}(?:=|\\s+)\\S+`, "g"), "");
  // `npm run x` forwards flags to the script only after `--`; pnpm/yarn/npx forward them anyway
  if (/(^|[\s;&|])npm\s+run(?:-script)?\s+\S+/.test(cmd) && !/\s--(?=\s|$)/.test(cmd)) cmd = `${cmd} --`;
  cmd = listen.flagStyle === "equals" ? `${cmd} ${flag}=${port}` : `${cmd} ${flag} ${port}`;
  if (listen.strictFlag !== undefined && !new RegExp(`(^|\\s)${escapeRe(listen.strictFlag)}(?=\\s|=|$)`).test(cmd)) cmd = `${cmd} ${listen.strictFlag}`;
  return cmd;
}

const render = (template: string, port: number, host: string): string => template.replaceAll("${port}", String(port)).replaceAll("${host}", host);

/**
 * Plans a stack start (pure). Order: topological by `dependsOn`; port assignment visits fixed listens
 * first, then pinned ones, then the rest, each group in that order. Per listen the wanted port is the
 * pin, else the preferred port; fixed or pinned listens never move (busy ⇒ conflict), the rest move to
 * the first free port of their range. Env: static `env`, then the listens, then the connects rendered
 * from the ports this plan assigned.
 */
export function planStack(input: PlanInput): RunPlan {
  const warnings: string[] = [];
  const conflicts: RunConflict[] = [];
  const all = allServices(input.repos);
  const byKey = new Map(all.map((s) => [s.key, s]));
  const selectedSet = new Set(input.selected);
  for (const key of input.selected) {
    if (byKey.has(key)) continue;
    const repo = input.repos.find((r) => key.startsWith(`${r.repoKey}.`));
    warnings.push(repo?.error !== undefined ? `${key}: ${repo.repoKey} is not available (${repo.error})` : `${key}: no such service`);
  }
  const ordered = topoOrder(all.filter((s) => selectedSet.has(s.key)), warnings);
  for (const s of ordered) {
    for (const id of s.service.dependsOn ?? []) {
      const dep = serviceKeyOf(s.repoKey, id);
      if (!byKey.has(dep)) warnings.push(`${s.key} depends on ${dep}, which does not exist`);
      else if (!selectedSet.has(dep)) warnings.push(`${s.key} depends on ${dep}, which is not in the stack`);
    }
  }

  // ---- ports ----
  const external = new Map<number, { pid: number; command: string }>();
  for (const l of input.listening) if (!input.ownPorts.has(l.port) && !external.has(l.port)) external.set(l.port, { pid: l.pid, command: l.command });
  const claimed = new Map<number, string>();
  const assigned = new Map<string, Record<string, number>>();
  const moved = new Map<string, Record<string, number>>();
  const blocked = new Map<string, string>();
  for (const s of ordered) {
    assigned.set(s.key, {});
    moved.set(s.key, {});
  }

  type Item = { svc: Svc; listen: RunListen; lkey: string; pin: number | undefined };
  const items: Item[] = ordered.flatMap((svc) =>
    svc.service.listens.map((listen) => {
      const lkey = listenKeyOf(svc.key, listen.name);
      return { svc, listen, lkey, pin: listen.how === "fixed" ? undefined : input.pins[lkey] };
    }),
  );
  const rank = (i: Item): number => (i.listen.how === "fixed" ? 0 : i.pin !== undefined ? 1 : 2);
  const queue = items.map((item, index) => ({ item, index })).sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index).map((x) => x.item);
  for (const item of queue) if (item.listen.how === "fixed" && input.pins[item.lkey] !== undefined) warnings.push(`${item.lkey}: fixed port ${item.listen.port} cannot be pinned elsewhere`);

  const busyWith = (port: number): string | undefined => {
    const owner = claimed.get(port);
    if (owner !== undefined) return owner;
    const ext = external.get(port);
    return ext !== undefined ? `external pid ${ext.pid} (${ext.command})` : undefined;
  };

  queue.forEach((item, qi) => {
    const { svc, listen, lkey, pin } = item;
    const ports = assigned.get(svc.key) as Record<string, number>;
    const want = pin ?? listen.port;
    if (blocked.has(svc.key)) {
      ports[listen.name] = want;
      return;
    }
    const block = (other: string, reason: string): void => {
      conflicts.push({ key: lkey, port: want, with: other, reason });
      blocked.set(svc.key, reason);
      ports[listen.name] = want;
    };
    const other = busyWith(want);
    if (other === undefined) {
      claimed.set(want, svc.key);
      ports[listen.name] = want;
      return;
    }
    if (listen.how === "fixed") return block(other, `${svc.key} needs fixed port ${want}, already taken by ${other}`);
    if (pin !== undefined) return block(other, `${svc.key} is pinned to port ${want}, already taken by ${other}`);
    const [lo, hi] = listen.range ?? [want + 1, want + 50];
    // prefer ports no later listen wants as its own, so one move does not cascade
    const laterWants = new Set(queue.slice(qi + 1).map((i) => i.pin ?? i.listen.port));
    let free: number | undefined;
    for (const avoid of [true, false]) {
      for (let p = lo; p <= hi && free === undefined; p++) if (p >= 1 && p <= 65535 && busyWith(p) === undefined && !(avoid && laterWants.has(p))) free = p;
      if (free !== undefined) break;
    }
    if (free === undefined) return block(other, `${svc.key}: port ${want} is taken by ${other} and nothing in ${lo}–${hi} is free`);
    claimed.set(free, svc.key);
    ports[listen.name] = free;
    (moved.get(svc.key) as Record<string, number>)[listen.name] = want;
  });

  // ---- env and commands ----
  const portOf = (target: string): { port: number; selected: boolean } | undefined => {
    const parsed = parseKey(target);
    if (parsed === undefined) return undefined;
    const listenName = parsed.listen;
    const svc = byKey.get(serviceKeyOf(parsed.repoKey, parsed.serviceId));
    if (svc === undefined) return undefined;
    const listen = listenName !== undefined ? svc.service.listens.find((l) => l.name === listenName) : svc.service.listens[0];
    if (listen === undefined) return undefined;
    const planned = assigned.get(svc.key)?.[listen.name];
    return planned !== undefined ? { port: planned, selected: true } : { port: listen.port, selected: false };
  };

  const rows: RunPlanRow[] = ordered.map((svc) => {
    const { service } = svc;
    const ports = assigned.get(svc.key) as Record<string, number>;
    const env: Record<string, string> = { ...service.env };
    let command = service.command;
    for (const listen of service.listens) {
      const port = ports[listen.name] as number;
      if (listen.how === "env") {
        if (listen.envVar !== undefined) env[listen.envVar] = String(port);
        else warnings.push(`${listenKeyOf(svc.key, listen.name)}: passed by env but names no variable`);
      } else if (listen.how === "flag") command = withPortFlag(command, listen, port);
    }
    for (const connect of service.connects) {
      const unresolved = /^\?:(\d+)$/.exec(connect.to);
      if (unresolved !== null) {
        const port = Number(unresolved[1]);
        env[connect.env] = render(connect.template, port, input.host);
        warnings.push(`${svc.key}: ${connect.env} points at port ${port}, which no service in the stack owns`);
        continue;
      }
      const target = portOf(connect.to);
      if (target === undefined) {
        warnings.push(`${svc.key}: ${connect.env} points at ${connect.to}, which is unknown`);
        continue;
      }
      env[connect.env] = render(connect.template, target.port, input.host);
      if (!target.selected) warnings.push(`${svc.key}: ${connect.env} → ${connect.to} not in the stack; using its default`);
    }
    const reason = blocked.get(svc.key);
    return {
      key: svc.key,
      name: service.name,
      repoKey: svc.repoKey,
      repoId: svc.repo.repoId,
      cwd: join(svc.repo.path, service.cwd ?? "."),
      command,
      ports,
      changedFrom: moved.get(svc.key) as Record<string, number>,
      env,
      fixed: service.listens.some((l) => l.how === "fixed"),
      readiness: service.readiness,
      dependsOn: (service.dependsOn ?? []).map((id) => serviceKeyOf(svc.repoKey, id)).filter((k) => selectedSet.has(k) && byKey.has(k)),
      ...(reason !== undefined ? { blocked: reason } : {}),
    };
  });

  // the profiles' own warnings (e.g. "loads .env with override") for repos in the stack
  for (const repo of input.repos) {
    if (!ordered.some((s) => s.repo === repo)) continue;
    for (const w of repo.profile?.warnings ?? []) warnings.push(`${repo.repoKey}: ${w}`);
  }

  return {
    status: conflicts.length > 0 ? "blocked" : "ok",
    rows,
    conflicts,
    warnings: [...new Set(warnings)],
    host: input.host,
    plannedAt: input.now,
  };
}
