import { selectExpertsSessions, selectProjects, selectThreadsByProject } from "@tide/client";
import type { ProposedPlan, ReadModel, Thread } from "@tide/contracts";
import { fuzzyRank } from "./fuzzy.ts";
import { providerIdOf } from "./vocab.ts";
import { SHORTCUTS, scopeApplies, shortcutKeys } from "./shortcuts.ts";
import { openThreadTerminal } from "./openInTerminal.ts";
import { useUi } from "../state/ui.ts";
import { showHowTideWorks } from "../components/shell/HowTideWorks.tsx";
import {
  createThread,
  detachWorktree,
  implementPlan,
  interruptTurn,
  requestArchive,
  requestDelete,
  settleThread,
  unsettleThread,
} from "./threadActions.ts";
import { canUndoSettle, undoLastSettle } from "./inboxActions.ts";
import { environmentName, setPrimaryEnvironment, useEnvironments } from "../state/environments.ts";
import { openAddMachine } from "../components/fleet/fleetUi.ts";

export type PaletteGroup = "Actions" | "Go to" | "Thread";

export interface PaletteItem {
  id: string;
  label: string;
  group: PaletteGroup;
  /** secondary line: project · provider · status, or a path */
  detail?: string;
  /** right-aligned keyboard hint */
  kbd?: string;
  run: () => void;
}

const GLYPH: Record<Thread["status"], string> = { idle: "○", running: "●", interrupted: "⏸", error: "✕" };

/** `◐` wins whenever the thread is waiting on the user, as in the rail. */
export function threadGlyph(thread: Thread): string {
  if (thread.interrupting === true) return "◑";
  return thread.attention ? "◐" : GLYPH[thread.status];
}

/** The newest still-proposed plan of a thread, if it has one. */
function latestPlan(model: ReadModel, threadId: string): ProposedPlan | undefined {
  let found: ProposedPlan | undefined;
  for (const plan of Object.values(model.plans)) {
    if (plan.threadId !== threadId || plan.status !== "proposed") continue;
    if (!found || plan.createdAt >= found.createdAt) found = plan;
  }
  return found;
}

/** Contextual actions for the thread the palette was opened on. */
function threadItems(model: ReadModel, thread: Thread): PaletteItem[] {
  const ui = useUi.getState();
  const items: PaletteItem[] = [
    { id: "thread:terminal", label: "Open in terminal", group: "Thread", run: () => void openThreadTerminal(thread.id) },
    thread.settledAt === undefined
      ? { id: "thread:settle", label: "Settle thread", group: "Thread", detail: "Close it from the inbox; the worktree stays", run: () => settleThread(thread.id) }
      : { id: "thread:unsettle", label: "Unsettle thread", group: "Thread", detail: "Back to the inbox", run: () => unsettleThread(thread.id) },
    { id: "thread:archive", label: "Archive…", group: "Thread", run: () => requestArchive(thread) },
    {
      id: "thread:child",
      label: "New child thread",
      group: "Thread",
      run: () =>
        void createThread(thread.projectId, thread.provider, {
          parentThreadId: thread.id,
          ...(thread.providerId === undefined ? {} : { providerId: thread.providerId }),
        }),
    },
  ];
  const plan = latestPlan(model, thread.id);
  if (plan) {
    items.push({
      id: "thread:implement-plan",
      label: "Implement latest plan",
      group: "Thread",
      run: () => void implementPlan(plan.id, { provider: thread.provider, useWorktree: true }),
    });
  }
  if (thread.status === "running" && thread.interrupting !== true) {
    items.push({
      id: "thread:stop",
      label: "Stop turn",
      group: "Thread",
      kbd: "Esc",
      run: () => interruptTurn(thread.id),
    });
  }
  items.push({
    id: "thread:delete",
    label: "Delete thread…",
    group: "Thread",
    run: () => requestDelete(thread),
  });
  if (thread.worktreePath !== undefined) {
    items.push({
      id: "thread:detach",
      label: "Detach worktree…",
      group: "Thread",
      detail: thread.worktreePath,
      run: () => ui.setThreadDialog({ kind: "detach", threadId: thread.id }),
    });
  }
  return items;
}

/** R10 pages: the PR tab and the usage glass box (the only way in on a phone). */
function pageItems(): PaletteItem[] {
  const ui = useUi.getState();
  return [
    { id: "page:prs", label: "Pull requests", group: "Go to", detail: "Every open PR, ranked by readiness", run: () => ui.showPrs(null) },
    { id: "page:usage", label: "Usage", group: "Go to", detail: "Tokens, cost and limits by harness", run: () => ui.showUsage() },
  ];
}

/** Every "go to" target: projects, threads, experts sessions. */
function navigationItems(model: ReadModel): PaletteItem[] {
  const ui = useUi.getState();
  const items: PaletteItem[] = [];
  for (const project of selectProjects(model)) {
    items.push({
      id: `project:${project.id}`,
      label: project.title,
      group: "Go to",
      detail: project.rootPath,
      run: () => {
        ui.selectProject(project.id);
        ui.showMission();
      },
    });
    for (const thread of selectThreadsByProject(model, project.id)) {
      items.push({
        id: `thread:${thread.id}`,
        label: `${threadGlyph(thread)} ${thread.title}`,
        group: "Go to",
        detail: `${project.title} · ${providerIdOf(thread)} · ${thread.interrupting === true ? "interrupting" : (thread.attention ?? thread.status)}`,
        run: () => ui.selectThread(thread.id),
      });
    }
    for (const session of selectExpertsSessions(model, project.id)) {
      items.push({
        id: `experts:${session.id}`,
        label: `◆ ${session.topic}`,
        group: "Go to",
        detail: `${project.title} · experts · ${session.phase}`,
        run: () => ui.selectExpertsSession(session.id),
      });
    }
  }
  return items;
}

/** The palette never offers to open itself, and lists ⌘N as a project-scoped item. */
const SURFACED_ELSEWHERE = new Set(["palette", "new-thread"]);

/**
 * Runnable keyboard-map entries that apply right now; surface-owned ones (⌘↵, y/n)
 * have no action.
 */
function shortcutItems(): PaletteItem[] {
  return SHORTCUTS.filter(
    (s) => s.run !== undefined && !SURFACED_ELSEWHERE.has(s.id) && scopeApplies(s.when),
  ).map((s) => ({
    id: `shortcut:${s.id}`,
    label: s.label,
    group: "Actions" as const,
    detail: s.group,
    kbd: shortcutKeys(s),
    run: () => {
      s.run?.();
    },
  }));
}

/** Project-scoped actions; the palette only offers them when a project is in scope. */
function projectItems(model: ReadModel, projectId: string): PaletteItem[] {
  return [
    {
      id: "project:new-thread",
      label: "New thread…",
      group: "Actions",
      kbd: shortcutKeys(SHORTCUTS.find((s) => s.id === "new-thread") ?? { id: "", keys: "⌘N", label: "", group: "Navigation" }),
      ...(model.projects[projectId] ? { detail: model.projects[projectId].title } : {}),
      run: () => useUi.getState().setNewThreadProject(projectId),
    },
    {
      id: "project:links",
      label: "Manage linked repositories…",
      group: "Actions",
      run: () => useUi.getState().setLinksProject(projectId),
    },
  ];
}

/** Settings › Environments, optionally with the "Add machine" sheet open. */
function showEnvironments(): void {
  const ui = useUi.getState();
  ui.setSettingsSection("environments");
  ui.showSettings();
}

/** R9: one "Switch primary environment" per other connected machine, and "Pair a machine…". */
function environmentItems(): PaletteItem[] {
  const { environments, statuses, primaryId } = useEnvironments.getState();
  const switches = environments
    .filter((env) => env.id !== primaryId && statuses[env.id]?.connection === "connected")
    .map((env) => ({
      id: `env:primary:${env.id}`,
      label: `Switch primary environment: ${environmentName(env.id)}`,
      group: "Actions" as const,
      detail: `Settings and new projects go to ${environmentName(env.id)}`,
      run: () => setPrimaryEnvironment(env.id),
    }));
  return [
    ...switches,
    {
      id: "env:pair",
      label: "Pair a machine…",
      group: "Actions" as const,
      detail: "Connect to Tide running on another computer",
      run: () => {
        showEnvironments();
        openAddMachine();
      },
    },
  ];
}

export interface PaletteInput {
  model: ReadModel;
  selectedThreadId: string | null;
  /** the rail's project selection; the selected thread's project wins over it */
  selectedProjectId?: string | null;
}

/** Every palette source, contextual thread actions first. */
export function buildPaletteItems({ model, selectedThreadId, selectedProjectId }: PaletteInput): PaletteItem[] {
  const thread = selectedThreadId ? model.threads[selectedThreadId] : undefined;
  const projectId = thread?.projectId ?? selectedProjectId ?? undefined;
  return [
    ...(thread ? threadItems(model, thread) : []),
    ...(projectId !== undefined && model.projects[projectId] ? projectItems(model, projectId) : []),
    ...shortcutItems(),
    ...(canUndoSettle()
      ? [{ id: "action:undo-settle", label: "Undo settle", group: "Actions" as const, kbd: "⌘Z", run: () => void undoLastSettle() }]
      : []),
    {
      id: "action:how-tide-works",
      label: "How Tide works",
      group: "Actions" as const,
      detail: "Threads, steering, checkpoints, merging",
      run: () => {
        useUi.getState().showMission();
        showHowTideWorks();
      },
    },
    ...environmentItems(),
    ...pageItems(),
    ...navigationItems(model),
  ];
}

const searchKey = (item: PaletteItem): string => `${item.label} ${item.detail ?? ""}`;

/**
 * Ranks items for the query. With no query the recents lead in recency order;
 * with one, fuzzy score decides and a recent item gets a small nudge.
 */
export function rankPaletteItems(query: string, items: PaletteItem[], recents: string[] = []): PaletteItem[] {
  const rank = new Map(recents.map((id, index) => [id, recents.length - index]));
  if (query.trim() === "") {
    const recent = recents.map((id) => items.find((i) => i.id === id)).filter((i): i is PaletteItem => !!i);
    const seen = new Set(recent.map((i) => i.id));
    return [...recent, ...items.filter((i) => !seen.has(i.id))];
  }
  return fuzzyRank(query, items, searchKey, 60)
    .map((r) => ({ item: r.item, score: r.score + (rank.get(r.item.id) ?? 0) * 0.5 }))
    .sort((a, b) => b.score - a.score)
    .map((r) => r.item);
}
