import { selectExpertsSessions, selectProjects, selectThreadsByProject } from "@tide/client";
import type { ProposedPlan, ReadModel, Thread } from "@tide/contracts";
import { fuzzyRank } from "./fuzzy.ts";
import { SHORTCUTS } from "./shortcuts.ts";
import { showToast } from "../state/toast.ts";
import { useUi } from "../state/ui.ts";
import {
  copyTerminalCommand,
  createThread,
  detachWorktree,
  fetchTerminalCommand,
  implementPlan,
  interruptTurn,
  requestArchive,
} from "./threadActions.ts";

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

function openTerminal(threadId: string): void {
  void fetchTerminalCommand(threadId)
    .then((command) => {
      if (command) return copyTerminalCommand(command);
      showToast("No harness session to resume yet");
      return undefined;
    })
    .catch(() => showToast("Could not resolve the resume command"));
}

/** Contextual actions for the thread the palette was opened on. */
function threadItems(model: ReadModel, thread: Thread): PaletteItem[] {
  const ui = useUi.getState();
  const items: PaletteItem[] = [
    { id: "thread:terminal", label: "Open in terminal", group: "Thread", run: () => openTerminal(thread.id) },
    { id: "thread:archive", label: "Archive…", group: "Thread", run: () => requestArchive(thread) },
    {
      id: "thread:child",
      label: "New child thread",
      group: "Thread",
      run: () => void createThread(thread.projectId, thread.provider, { parentThreadId: thread.id }),
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
        detail: `${project.title} · ${thread.provider} · ${thread.interrupting === true ? "interrupting" : (thread.attention ?? thread.status)}`,
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

/** Runnable keyboard-map entries; surface-owned ones (⌘↵, y/n) have no action. */
function shortcutItems(): PaletteItem[] {
  return SHORTCUTS.filter((s) => s.run !== undefined).map((s) => ({
    id: `shortcut:${s.id}`,
    label: s.label,
    group: "Actions" as const,
    detail: s.group,
    kbd: s.keys,
    run: () => {
      s.run?.();
    },
  }));
}

export interface PaletteInput {
  model: ReadModel;
  selectedThreadId: string | null;
}

/** Every palette source, contextual thread actions first. */
export function buildPaletteItems({ model, selectedThreadId }: PaletteInput): PaletteItem[] {
  const thread = selectedThreadId ? model.threads[selectedThreadId] : undefined;
  return [
    ...(thread ? threadItems(model, thread) : []),
    ...shortcutItems(),
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
