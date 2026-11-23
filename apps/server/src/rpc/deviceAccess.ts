import type { ClientCommand, DeviceAccess, rpcMethods } from "@tide/contracts";

/**
 * R19: what a paired device with `limited` access may call. Every RPC method and every client
 * command is classified here: `limited` = any paired device, `full` = devices the owner turned
 * Full access on for. The owner (master token) is never checked against this table. The typed
 * records make a new method or command a compile error until it is classified; a name missing at
 * runtime (an older table against newer contracts) is refused for limited devices.
 */
export type AccessNeeded = DeviceAccess;

export const METHOD_ACCESS: Record<keyof typeof rpcMethods, AccessNeeded> = {
  "server.info": "limited",
  "settings.get": "limited",
  "settings.set": "full",
  "decisions.stats": "limited",
  // per command, see COMMAND_ACCESS
  "orchestration.dispatch": "limited",
  "project.init": "full",
  "project.ensure": "full",
  "project.detectRepo": "full",
  "providers.list": "limited",
  "providers.commands": "limited",
  // owner-only for every device (deviceGuard), whatever this says
  "env.pairingCode": "full",
  "env.clients.setAccess": "full",
  "env.discover": "limited",
  "env.clients.list": "limited",
  "env.clients.revoke": "limited",
  "env.updateHarnesses": "full",
  "pr.list": "limited",
  "pr.detail": "limited",
  "pr.diff": "limited",
  "pr.comment": "limited",
  "pr.review": "limited",
  "pr.merge": "limited",
  "pr.link": "limited",
  "attachments.upload": "limited",
  // opens something on the host machine
  "workspace.openExternal": "full",
  "ports.list": "limited",
  "project.detectIcon": "limited",
  "usage.summary": "limited",
  "usage.repair": "full",
  "providers.acpRegistry": "limited",
  "threads.search": "limited",
  "thread.regenerateTitle": "limited",
  // only use is opening a terminal on the host
  "thread.terminalCommand": "full",
  "model.subscribe": "limited",
  "model.get": "limited",
  unsubscribe: "limited",
  cancel: "limited",
  "vcs.status": "limited",
  "vcs.baseStatus": "limited",
  // moves the project's own base checkout, not a thread's worktree
  "vcs.pullBase": "full",
  "vcs.turnDiff": "limited",
  "vcs.threadDiff": "limited",
  "vcs.commits": "limited",
  "vcs.commitDiff": "limited",
  "vcs.fileAt": "limited",
  // discards files in a repo outside the thread's worktree
  "vcs.linkedRevert": "full",
  "fs.list": "limited",
  "fs.read": "limited",
  "fs.readBinary": "limited",
  "fs.watch": "limited",
  "fs.search": "limited",
  "secret.provide": "limited",
  "fs.write": "full",
  "fs.create": "full",
  "fs.rename": "full",
  "fs.delete": "full",
  // walks the host's directories outside any project (the project picker)
  "fs.browse": "full",
  // a terminal is a shell on the host and its scrollback can show secrets
  "pty.create": "full",
  "pty.attach": "full",
  "pty.write": "full",
  "pty.resize": "full",
  "pty.kill": "full",
  "pty.list": "full",
  "run.profiles.get": "limited",
  "run.plan": "limited",
  "run.subscribe": "limited",
  "run.profiles.scan": "full",
  "run.profiles.set": "full",
  "run.quickstart.write": "full",
  "run.start": "full",
  "run.stop": "full",
  "run.restart": "full",
  // agent sockets only (the router keeps client sockets off agent.*); fail closed regardless
  "agent.dispatch": "full",
  "agent.harnesses": "full",
  "agent.context": "full",
  "agent.threadStatus": "full",
  "agent.thread.list": "full",
  "agent.thread.read": "full",
  "agent.thread.send": "full",
  "agent.thread.wait": "full",
  "agent.thread.interrupt": "full",
  "agent.thread.archive": "full",
  "agent.pending.list": "full",
  "agent.pending.respond": "full",
  "agent.thread.diff": "full",
  "agent.task.list": "full",
  "agent.secret.request": "full",
};

/** Commands carrying a runtime mode are allowed for limited devices only with a mode below full access (see FULL_ACCESS_MODE). */
export const COMMAND_ACCESS: Record<ClientCommand["type"], AccessNeeded> = {
  "project.create": "full",
  "project.update": "full",
  "project.archive": "full",
  "project.unarchive": "full",
  "project.link.add": "full",
  "project.link.update": "full",
  "project.link.remove": "full",
  "project.runStack.set": "full",
  "thread.create": "limited",
  "thread.update": "limited",
  "thread.archive": "limited",
  "thread.unarchive": "limited",
  "thread.delete": "limited",
  "turn.request": "limited",
  "turn.interrupt": "limited",
  "turn.dequeue": "limited",
  "approval.respond": "limited",
  "user-input.respond": "limited",
  "plan.implement": "limited",
  "plan.dismiss": "limited",
  "thread.publish": "limited",
  "thread.merge": "limited",
  "worktree.detach": "limited",
  "turn.steer": "limited",
  "turn.edit": "limited",
  "turn.reorder": "limited",
  "turn.promote": "limited",
  "thread.fork": "limited",
  "thread.side": "limited",
  "thread.rollback": "limited",
  "thread.snooze": "limited",
  "thread.resume": "limited",
  "thread.limit-policy": "limited",
  // R20: the cap is the owner's guard on their subscription; a limited device neither changes nor lifts it
  "quota.set": "full",
  "quota.lift": "full",
  "pr.watch": "limited",
  "thread.settle": "limited",
  "thread.unsettle": "limited",
  // scheduled tasks and webhooks run turns unattended with their own mode
  "task.create": "full",
  "task.update": "full",
  "task.delete": "full",
  "task.run-now": "full",
  "team.run": "limited",
  "experts.create": "limited",
  "experts.start": "limited",
  "experts.post": "limited",
  "experts.set-phase": "limited",
  "experts.archive": "limited",
};

/** the RuntimeMode literal a limited device may never set */
export const FULL_ACCESS_MODE = "full-access";

export const LIMITED_REFUSAL = "this device has limited access; turn on Full access for it on the machine itself";

/**
 * True when any `mode` key anywhere in the params asks for full access (thread.create/update,
 * plan.implement, team.run stages, tasks, and any future field named the same way).
 */
export function asksFullAccess(value: unknown, depth = 0): boolean {
  if (depth > 8 || typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return value.some((v) => asksFullAccess(v, depth + 1));
  for (const [key, v] of Object.entries(value)) {
    if (key === "mode" && v === FULL_ACCESS_MODE) return true;
    if (asksFullAccess(v, depth + 1)) return true;
  }
  return false;
}

const lookup = (table: Readonly<Record<string, AccessNeeded>>, name: string): AccessNeeded =>
  Object.hasOwn(table, name) ? (table[name] as AccessNeeded) : "full";

/** The refusal for a limited device, or undefined when the call is within its level. */
export function limitedRefusal(method: string, params: unknown): string | undefined {
  if (lookup(METHOD_ACCESS, method) === "full") return LIMITED_REFUSAL;
  if (method === "orchestration.dispatch") {
    const type = (params as { command?: { type?: unknown } } | undefined)?.command?.type;
    if (typeof type !== "string" || lookup(COMMAND_ACCESS, type) === "full") return LIMITED_REFUSAL;
  }
  if (asksFullAccess(params)) return "this device has limited access and cannot use Full access mode; turn on Full access for it on the machine itself";
  return undefined;
}
