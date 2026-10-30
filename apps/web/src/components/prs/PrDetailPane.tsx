import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { prReadiness, selectThreadsByProject } from "@tide/client";
import type { PullRequest } from "@tide/contracts";
import { errorText } from "../../lib/dispatchOrToast.ts";
import { showToast } from "../../state/toast.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Pill } from "../ui/Pill.tsx";
import { Select } from "../ui/Select.tsx";
import { AddressButton, MergeBox, ReviewBox } from "./PrActions.tsx";
import { PrComments } from "./PrComments.tsx";
import { PrFiles } from "./PrFiles.tsx";
import { linkPr } from "./prActions.ts";
import { loadPrs, type PrEntry } from "./prData.ts";
import { READINESS_TONE, reviewText } from "./prFilters.ts";
import { usePrDetail, usePrDiff } from "./usePrDetail.ts";
import styles from "./PrDetail.module.css";

type Tab = "overview" | "files" | "comments";

const RUN_GLYPH: Record<string, string> = { success: "✔", failure: "✘", pending: "…", skipped: "–" };

function CheckRuns({ pr }: { pr: PullRequest }) {
  const runs = pr.checkRuns ?? [];
  if (runs.length === 0) return pr.checks ? <p className={styles.note}>Checks: {pr.checks}</p> : null;
  return (
    <ul className={styles.runs} aria-label="Check runs">
      {runs.map((run) => (
        <li key={run.name} className={`${styles.run} ${styles[run.status] ?? ""}`}>
          <span aria-hidden="true">{RUN_GLYPH[run.status] ?? "·"}</span>
          {run.url ? (
            <a href={run.url} target="_blank" rel="noreferrer">
              {run.name}
            </a>
          ) : (
            <span>{run.name}</span>
          )}
          <span className={styles.runStatus}>{run.status}</span>
        </li>
      ))}
    </ul>
  );
}

/** "Open thread" for a linked PR, else a picker of the project's live threads → `pr.link`. */
function ThreadLink({ entry }: { entry: PrEntry }) {
  const thread = useModel((s) => (entry.threadId ? s.model.threads[entry.threadId] : undefined));
  const threads = selectThreadsByProject(useModel((s) => s.model), entry.projectId);
  const selectThread = useUi((s) => s.selectThread);
  const [picking, setPicking] = useState(false);
  const [choice, setChoice] = useState<string>("");

  if (thread) {
    return (
      <Button variant="quiet" onClick={() => selectThread(thread.id)} title={thread.title}>
        Open thread
      </Button>
    );
  }
  if (!picking) {
    return (
      <Button variant="quiet" disabled={threads.length === 0} title={threads.length === 0 ? "No live thread in this project" : undefined} onClick={() => setPicking(true)}>
        Link to thread…
      </Button>
    );
  }
  const options = threads.map((t) => ({ value: t.id, label: t.title }));
  return (
    <span className={styles.row}>
      <Select label="Thread to link" value={choice} options={options} onSelect={setChoice} placeholder="Pick a thread…" searchable />
      <Button
        variant="primary"
        disabled={choice === ""}
        onClick={() => {
          linkPr(choice, entry.pr.url)
            .then(() => {
              setPicking(false);
              void loadPrs();
            })
            .catch((error: unknown) => showToast(`Linking the PR failed: ${errorText(error)}`));
        }}
      >
        Link
      </Button>
      <Button variant="quiet" onClick={() => setPicking(false)}>
        Cancel
      </Button>
    </span>
  );
}

/** The open PR: description and checks, its files, its comments, and what can be done with it. */
export function PrDetailPane({ entry, onClose }: { entry: PrEntry; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("overview");
  const { load, reload } = usePrDetail(entry);
  const diff = usePrDiff(entry, tab === "files");
  const pr = load.state === "ok" ? load.data.pr : entry.pr;
  const view: PrEntry = { ...entry, pr };
  const readiness = prReadiness(pr);
  const comments = load.state === "ok" ? load.data.comments : [];
  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "files", label: `Files${pr.changedFiles === undefined ? "" : ` · ${pr.changedFiles}`}` },
    { id: "comments", label: `Comments${load.state === "ok" ? ` · ${comments.length}` : ""}` },
  ];

  return (
    <section className={styles.pane} aria-label={`PR #${pr.number}`}>
      <header className={styles.header}>
        <Button variant="quiet" onClick={onClose} aria-label="Close PR" title="Back to the list">
          <Icon name="chevronRight" className={styles.back ?? ""} />
        </Button>
        <h3 className={styles.title}>
          <span className={styles.number}>#{pr.number}</span> {pr.title ?? pr.url}
        </h3>
        <Pill tone={READINESS_TONE[readiness.label]}>{readiness.label}</Pill>
      </header>
      <p className={styles.sub}>
        {pr.repo ? `${pr.repo} · ` : ""}
        {pr.author ? `@${pr.author} · ` : ""}
        {pr.head ? `${pr.head} → ${pr.base ?? "?"}` : ""}
        {reviewText(pr) ? ` · ${reviewText(pr)}` : ""}
        {readiness.reasons.length > 0 ? ` · ${readiness.reasons.join(", ")}` : ""}
      </p>
      <div className={styles.links}>
        <a className={styles.external} href={pr.url} target="_blank" rel="noreferrer">
          Open in browser
          <Icon name="external" size={12} />
        </a>
        <ThreadLink entry={entry} />
        <AddressButton entry={view} comments={comments} />
      </div>
      <div className={styles.tabs} role="tablist" aria-label="PR sections">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`${styles.tab} ${tab === t.id ? styles.tabOn : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className={styles.body}>
        {load.state === "error" ? <p className={styles.error}>Could not load the PR: {load.message}</p> : null}
        {tab === "overview" ? (
          <>
            {load.state === "loading" ? <p className={styles.note}>Loading…</p> : null}
            {load.state === "ok" ? (
              load.data.body?.trim() ? (
                <div className={styles.markdown}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{load.data.body}</ReactMarkdown>
                </div>
              ) : (
                <p className={styles.note}>No description.</p>
              )
            ) : null}
            <h4 className={styles.section}>Checks</h4>
            <CheckRuns pr={pr} />
            <h4 className={styles.section}>Merge</h4>
            <MergeBox entry={view} onDone={reload} />
            <h4 className={styles.section}>Review</h4>
            <ReviewBox entry={view} onDone={reload} />
          </>
        ) : null}
        {tab === "files" ? <PrFiles load={diff} /> : null}
        {tab === "comments" ? (
          <>
            <PrComments comments={comments} />
            <ReviewBox entry={view} onDone={reload} />
          </>
        ) : null}
      </div>
    </section>
  );
}
