import { useEffect, useState } from "react";
import { selectProjects } from "@tide/client";
import { useViewport } from "../../lib/useViewport.ts";
import { relativeTime } from "../../lib/relativeTime.ts";
import { plural } from "../../lib/format.ts";
import { useMultiEnv } from "../../lib/envTargets.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { SplitPane } from "../shell/SplitPane.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Select } from "../ui/Select.tsx";
import { PrDetailPane } from "./PrDetailPane.tsx";
import { PrRow } from "./PrRow.tsx";
import { loadPrs, usePrs } from "./prData.ts";
import { filterPrs, type PrSort } from "./prFilters.ts";
import styles from "./Prs.module.css";

const SORTS: { value: PrSort; label: string }[] = [
  { value: "readiness", label: "Readiness" },
  { value: "updated", label: "Updated" },
];

function fetchedText(at: number | undefined): string {
  if (at === undefined) return "";
  const stamp = relativeTime(at);
  return stamp === "now" ? "fetched just now" : `fetched ${stamp} ago`;
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={`${styles.chip} ${on ? styles.chipOn : ""}`} aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  );
}

/**
 * The PR tab: every PR the connected servers' forges report (thread-linked ones and
 * the viewer's own), ranked by readiness. A row opens the detail pane beside the list
 * (full screen on a phone).
 */
export function PrsView() {
  const projectId = useUi((s) => s.prsProjectId);
  const showPrs = useUi((s) => s.showPrs);
  const projects = selectProjects(useModel((s) => s.model));
  const { items, viewers, fetchedAt, loading, errors, scope } = usePrs();
  const [mine, setMine] = useState(false);
  const [sort, setSort] = useState<PrSort>("readiness");
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const multiEnv = useMultiEnv();
  const { phone } = useViewport();

  useEffect(() => {
    void loadPrs();
  }, []);

  const shown = filterPrs(items, { projectId, scope, mine, sort }, viewers);
  const hasViewer = Object.keys(viewers).length > 0;
  const entry = shown.find((e) => e.key === selected) ?? items.find((e) => e.key === selected);

  const list = (
    <section className={styles.view} aria-label="Pull requests">
      <div className={styles.head}>
        <div className={styles.headText}>
          <h2 className={styles.pageTitle}>Pull requests</h2>
          <p className={styles.metaLine}>
            <span className={styles.count}>{plural(shown.length, "PR")}</span>
            <span className={styles.fetched}>{loading ? "loading…" : fetchedText(fetchedAt)}</span>
          </p>
        </div>
        <Button variant="quiet" className={styles.refresh} disabled={loading} onClick={() => void loadPrs({ refresh: true })}>
          <Icon name="refresh" size={14} />
          Refresh
        </Button>
      </div>
      <div className={styles.filters} role="toolbar" aria-label="PR filters">
        <Chip on={projectId === null} onClick={() => showPrs(null)}>
          All projects
        </Chip>
        {projects.map((p) => (
          <Chip key={p.id} on={projectId === p.id} onClick={() => showPrs(p.id)}>
            {p.title}
          </Chip>
        ))}
        <span className={styles.sep} aria-hidden="true" />
        <Chip on={scope === "open"} onClick={() => void loadPrs({ state: "open" })}>
          Open
        </Chip>
        <Chip on={scope === "all"} onClick={() => void loadPrs({ state: "all" })}>
          All
        </Chip>
        {hasViewer ? (
          <Chip on={mine} onClick={() => setMine(!mine)}>
            Mine
          </Chip>
        ) : null}
        <span className={styles.sortBox}>
          <Select label="Sort" value={sort} options={SORTS} onSelect={setSort} />
        </span>
      </div>
      {errors.map((e) => (
        <p key={e} className={styles.error} role="alert">
          {e}
        </p>
      ))}
      {shown.length === 0 && !loading ? (
        <p className={styles.empty}>
          {items.length === 0 ? "No pull requests. PRs opened from a thread, and your own, show up here." : "No PR matches these filters."}
        </p>
      ) : (
        <ul className={styles.list}>
          {shown.map((e) => (
            <PrRow key={e.key} entry={e} selected={e.key === selected} showEnv={multiEnv} onOpen={() => setSelected(e.key)} />
          ))}
        </ul>
      )}
    </section>
  );

  if (!entry) return list;
  const pane = <PrDetailPane key={entry.key} entry={entry} onClose={() => setSelected(undefined)} />;
  if (phone) return pane;
  return <SplitPane primary={list} secondary={pane} />;
}
