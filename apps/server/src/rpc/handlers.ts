import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Git } from "../vcs/git.ts";
import { isInternalCommand, type ClientCommand, type EventRecord } from "@tide/contracts";
import { CommandError, type Engine } from "../orchestration/engine.ts";
import type { EventStore } from "../orchestration/store.ts";
import type { DriverRegistry } from "../provider/registry.ts";
import { resumableSessionId, threadCwd } from "../provider/sessions.ts";
import type { RemoteInfo } from "./remote.ts";
import type { SettingsStore } from "../settings.ts";
import { RpcException, type RpcRouter } from "./router.ts";

export interface HandlerDeps {
  engine: Engine;
  store: EventStore;
  registry: DriverRegistry;
  environmentId: string;
  version: string;
  startedAt: number;
  tideHome?: string;
  tools?: { git: boolean; gh: boolean; rg: boolean };
  /** how clients reach this server; resolved per call because the port is known only after listen */
  remote?: (options: { includePairing: boolean }) => RemoteInfo;
  /** W1: resolves + validates a linked-repo path; injectable so tests need no real directories */
  resolveDir?: (path: string) => Promise<string>;
  settings?: SettingsStore;
  /** tests inject a Git bound to a sandboxed env (no global identity, no hooks) */
  git?: (cwd: string) => Git;
}

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const INIT_IDENTITY = ["-c", "user.name=Tide", "-c", "user.email=tide@localhost"];

/**
 * A project from nothing. The folder must be new or empty: Tide never adopts a folder with
 * files in it (an initial commit that silently swallowed node_modules/ or a .env would be
 * worse than asking the user to `git init` by hand). The empty first commit is what lets the
 * first thread branch a worktree off `main`.
 */
async function initProject(parentPath: string, name: string, git: (cwd: string) => Git): Promise<string> {
  if (!isAbsolute(parentPath)) throw new RpcException("invalid-params", `parent path ${parentPath} must be absolute`);
  if (!PROJECT_NAME.test(name)) throw new RpcException("invalid-params", `project name ${JSON.stringify(name)} must be a plain folder name (letters, digits, . _ -)`);
  let parent: string;
  try {
    parent = await realpath(parentPath);
  } catch {
    throw new RpcException("not-found", `parent folder ${parentPath} does not exist`);
  }
  if (!(await stat(parent)).isDirectory()) throw new RpcException("invalid-params", `${parentPath} is not a directory`);
  const root = join(parent, name);
  try {
    const existing = await stat(root);
    if (!existing.isDirectory()) throw new RpcException("conflict", `${root} exists and is not a directory`);
    if ((await readdir(root)).length > 0) throw new RpcException("conflict", `${root} is not empty; run \`git init\` there yourself and add it as a repository`);
  } catch (err) {
    if (err instanceof RpcException) throw err;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await mkdir(root, { recursive: false });
  }
  const repo = git(root);
  await repo.run(["init", "-q", "-b", "main"]);
  // identity only for this one commit: the user's global git config stays authoritative for everything after
  await repo.run([...INIT_IDENTITY, "commit", "-q", "--allow-empty", "-m", "Initial commit"]);
  return root;
}

/**
 * The only filesystem check in the command path: a linked repo has to exist as a directory
 * on this host, and symlinked link paths are recorded by their real path so containment
 * checks in the drivers compare like with like. The decider stays pure.
 */
async function defaultResolveDir(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new RpcException("invalid-params", `link path ${path} must be absolute`);
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw new RpcException("not-found", `link path ${path} does not exist`);
  }
  const info = await stat(real);
  if (!info.isDirectory()) throw new RpcException("invalid-params", `link path ${path} is not a directory`);
  return real;
}

export function registerHandlers(router: RpcRouter, deps: HandlerDeps): void {
  router.register("server.info", async (_input, ctx) => {
    // the pairing URL carries the bearer token: user-facing client sockets only
    const remote = deps.remote?.({ includePairing: ctx.agentThreadId === undefined });
    return {
      environmentId: deps.environmentId,
      version: deps.version,
      startedAt: deps.startedAt,
      ...(deps.tideHome !== undefined ? { tideHome: deps.tideHome, worktreeRoot: `${deps.tideHome}/worktrees` } : {}),
      ...(deps.tools !== undefined ? { tools: deps.tools } : {}),
      ...(remote !== undefined ? { remote } : {}),
    };
  });

  const resolveDir = deps.resolveDir ?? defaultResolveDir;

  // user settings live on the server so every client and every server-created thread agrees
  router.register("settings.get", async (_input, ctx) => {
    if (ctx.agentThreadId !== undefined) throw new RpcException("forbidden", "settings are not available to agent sockets");
    if (!deps.settings) throw new RpcException("internal", "settings store not configured");
    return deps.settings.get();
  });
  router.register("settings.set", async (input, ctx) => {
    if (ctx.agentThreadId !== undefined) throw new RpcException("forbidden", "settings are not available to agent sockets");
    if (!deps.settings) throw new RpcException("internal", "settings store not configured");
    return deps.settings.set(input.patch);
  });

  router.register("orchestration.dispatch", async (input) => {
    // The schema already accepts only ClientCommand; this is the belt to that brace.
    const type = input.command.type;
    if (isInternalCommand(input.command)) {
      throw new RpcException("forbidden", `${type} is a server-internal command`);
    }
    let command: ClientCommand = input.command;
    if (command.type === "project.link.add") command = { ...command, path: await resolveDir(command.path) };
    try {
      return await deps.engine.dispatch(command);
    } catch (err) {
      if (err instanceof CommandError) throw new RpcException(err.code, err.message);
      throw err;
    }
  });

  router.register("project.init", async (input, ctx) => {
    if (ctx.agentThreadId !== undefined) throw new RpcException("forbidden", "agents cannot create projects");
    const rootPath = await initProject(input.parentPath, input.name, deps.git ?? ((cwd) => new Git(cwd)));
    try {
      const result = await deps.engine.dispatch({ type: "project.create", title: input.title ?? input.name, rootPath });
      const created = result.events[0]?.event;
      if (created?.type !== "project.created") throw new RpcException("internal", "project.create produced no project");
      return { projectId: created.project.id, rootPath };
    } catch (err) {
      if (err instanceof CommandError) throw new RpcException(err.code, err.message);
      throw err;
    }
  });

  router.register("providers.list", async (input) => deps.registry.statusAll(input.refresh ?? false));

  router.register("thread.terminalCommand", async (input) => {
    const model = deps.engine.getModel();
    const thread = model.threads[input.threadId];
    if (!thread) throw new RpcException("not-found", `unknown thread ${input.threadId}`);
    const project = model.projects[thread.projectId];
    if (!project) throw new RpcException("not-found", `unknown project ${thread.projectId}`);
    const cwd = threadCwd(thread, project);
    // same rule as the session directory: never resume another harness's session id
    const sessionId = resumableSessionId(thread, model);
    if (sessionId === undefined) return { cwd };
    try {
      const instance = await deps.registry.get(thread.provider);
      const command = instance.terminalCommand(sessionId, cwd);
      return command === undefined ? { cwd } : { cwd, command };
    } catch {
      // no driver for this harness on this machine: still tell the client where it lives
      return { cwd };
    }
  });

  router.register("model.get", async () => deps.engine.getModel());

  router.registerStream("model.subscribe", async (input, _ctx, emit) => {
    // Subscribe before reading state, buffering anything that lands while we
    // build the catch-up frames, so no event can slip through the gap.
    let live = false;
    let lastSeq = input.fromSeq !== undefined && input.fromSeq >= 0 ? input.fromSeq : -1;
    const buffered: EventRecord[] = [];
    const push = (record: EventRecord): void => {
      if (record.seq <= lastSeq) return;
      lastSeq = record.seq;
      emit({ kind: "event", record });
    };
    const unsubscribe = deps.engine.subscribe((record) => {
      if (live) push(record);
      else buffered.push(record);
    });

    if (input.fromSeq !== undefined && input.fromSeq >= 0) {
      for (const record of deps.store.readFrom(input.fromSeq + 1)) push(record);
    } else {
      const model = deps.engine.getModel();
      lastSeq = model.seq;
      emit({ kind: "snapshot", model });
    }

    live = true;
    for (const record of buffered) push(record);
    return unsubscribe;
  });

  router.register("unsubscribe", async (input, ctx) => ({ ok: ctx.cancelStream(input.id) }));
}
