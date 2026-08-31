import { useEffect } from "react";
import { selectActiveTurn } from "@tide/client";
import { useSelectedThread } from "../../state/hooks.ts";
import { useModel } from "../../state/model.ts";
import { watchDocs } from "../../state/docs.ts";
import { openExpertsTab, toggleTree, useActiveTab, useThreadTabs, useWorkbench } from "../../state/workbench.ts";
import { toggleDrawer, useTerminals } from "../../state/terminals.ts";
import { Kbd } from "../ui/Kbd.tsx";
import { ChangesTab } from "./ChangesTab.tsx";
import { TabStrip } from "./TabStrip.tsx";
import { FileTree } from "./tree/FileTree.tsx";
import { FileTab } from "./editor/FileTab.tsx";
import { SearchPanel } from "./search/SearchPanel.tsx";
import { Board } from "../experts/Board.tsx";
import { TerminalDrawer } from "./terminal/TerminalDrawer.tsx";
import styles from "./Workbench.module.css";

function WorkbenchFor({ threadId, expertsSessionId }: { threadId: string; expertsSessionId?: string }) {
  const tabs = useThreadTabs(threadId);
  const active = useActiveTab(threadId);
  const treeVisible = useWorkbench((s) => s.treeVisible);
  const drawerOpen = useTerminals((s) => s.drawerOpen);
  const running = useModel((s) => selectActiveTurn(s.model, threadId) !== undefined);

  // one fs.watch per thread keeps open editors in step with what the agent writes
  useEffect(() => watchDocs(threadId), [threadId]);
  // an expert's thread keeps its panel one tab away
  useEffect(() => {
    if (expertsSessionId !== undefined) openExpertsTab(threadId);
  }, [threadId, expertsSessionId]);

  return (
    <section className={styles.workbench} aria-label="Workbench">
      <TabStrip threadId={threadId} tabs={tabs} active={active} running={running}>
        <button
          type="button"
          className={styles.iconToggle}
          aria-pressed={treeVisible}
          title="Toggle file tree (⌘⇧E)"
          aria-label="Toggle file tree"
          onClick={toggleTree}
        >
          ▤
        </button>
        <button
          type="button"
          className={styles.terminalToggle}
          aria-pressed={drawerOpen}
          title="Toggle terminal drawer"
          onClick={toggleDrawer}
        >
          Terminal <Kbd>⌘`</Kbd>
        </button>
      </TabStrip>

      <div className={styles.body}>
        {treeVisible ? <FileTree threadId={threadId} /> : null}
        <div className={styles.content}>
          {active.kind === "changes" ? <ChangesTab /> : null}
          {active.kind === "search" ? <SearchPanel threadId={threadId} /> : null}
          {active.kind === "experts" ? (
            expertsSessionId === undefined ? null : <Board sessionId={expertsSessionId} />
          ) : null}
          {active.kind === "file" ? <FileTab key={active.path} threadId={threadId} path={active.path} /> : null}
        </div>
      </div>

      <TerminalDrawer threadId={threadId} />
    </section>
  );
}

export function Workbench() {
  const thread = useSelectedThread();
  if (!thread) {
    return (
      <section className={styles.workbench} aria-label="Workbench">
        <p className={styles.empty}>No thread selected.</p>
      </section>
    );
  }
  return (
    <WorkbenchFor
      key={thread.id}
      threadId={thread.id}
      {...(thread.expertsSessionId === undefined ? {} : { expertsSessionId: thread.expertsSessionId })}
    />
  );
}
