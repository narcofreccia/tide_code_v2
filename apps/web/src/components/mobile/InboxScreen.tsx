import { useState } from "react";
import { selectInbox, selectProjects, selectRailGroups } from "@tide/client";
import type { Project, Thread } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { useRailSearch } from "../../state/railSearch.ts";
import { useServerSettings } from "../../state/serverSettings.ts";
import { useUi } from "../../state/ui.ts";
import { useTicker } from "../mission/useTicker.ts";
import { RailSearchInput, RailSearchResults } from "../shell/RailSearch.tsx";
import { Icon } from "../ui/Icon.tsx";
import { SwipeRow } from "./SwipeRow.tsx";
import styles from "./InboxScreen.module.css";

function Section({ name, threads, collapsible }: { name: string; threads: Thread[]; collapsible?: boolean }) {
  const [open, setOpen] = useState(!collapsible);
  if (threads.length === 0) return null;
  return (
    <section className={styles.group} aria-label={name}>
      {collapsible ? (
        <button type="button" className={styles.toggle} aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="chevronRight" size={14} className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`} />
          {name} <span className={styles.count}>· {threads.length}</span>
        </button>
      ) : (
        <h3 className={styles.heading}>
          {name} <span className={styles.count}>· {threads.length}</span>
        </h3>
      )}
      {open ? (
        <ul className={styles.list}>
          {threads.map((t) => (
            <SwipeRow key={t.id} thread={t} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function byProject(projects: Project[], threads: Thread[]): Thread[] {
  const order = new Map(projects.map((p, i) => [p.id, i] as const));
  return [...threads].sort((a, b) => (order.get(a.projectId) ?? 0) - (order.get(b.projectId) ?? 0));
}

/**
 * The phone's landing screen: the rail's search field and inbox groups at full width, rows
 * 44px tall and swipeable. Needs you · Inbox, then Working · Snoozed · Settled folded away.
 * A query swaps the groups for the rail's own results list.
 */
export function InboxScreen() {
  const model = useModel((s) => s.model);
  const now = useTicker(60_000);
  const workingSection = useServerSettings((s) => s.settings.inbox.workingSection);
  const openNewThread = useUi((s) => s.openNewThread);
  const query = useRailSearch((s) => s.query);
  const projects = selectProjects(model);

  const waiting = new Set(selectInbox(model).map((i) => i.thread.id));
  const needs: Thread[] = [];
  const inbox: Thread[] = [];
  const working: Thread[] = [];
  const snoozed: Thread[] = [];
  const settled: Thread[] = [];
  for (const p of projects) {
    const g = selectRailGroups(model, p.id, now, { workingSection });
    for (const t of [...g.pinned, ...g.threads]) (waiting.has(t.id) ? needs : inbox).push(t);
    working.push(...g.working);
    snoozed.push(...g.snoozed);
    settled.push(...g.settled);
  }

  const empty = needs.length + inbox.length + working.length + snoozed.length + settled.length === 0;
  return (
    <section className={styles.screen} aria-label="Inbox">
      <header className={styles.head}>
        <RailSearchInput projectId={null} />
        <button type="button" className={styles.new} onClick={() => openNewThread({})}>
          <Icon name="plus" size={16} />
          Thread
        </button>
      </header>
      <div className={styles.scroll}>
        {query.trim() !== "" ? (
          <RailSearchResults query={query} projectId={null} projectIds={projects.map((p) => p.id)} showProject={projects.length > 1} />
        ) : (
          <>
            <Section name="Needs you" threads={byProject(projects, needs)} />
            <Section name="Inbox" threads={byProject(projects, inbox)} />
            <Section name="Working" threads={working} collapsible />
            <Section name="Snoozed" threads={snoozed} collapsible />
            <Section name="Settled" threads={settled} collapsible />
            {empty ? <p className={styles.empty}>Nothing here yet. Add a project and a thread from the desktop app or with + Thread.</p> : null}
          </>
        )}
      </div>
    </section>
  );
}
