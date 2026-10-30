import { useModel } from "../../state/model.ts";
import { localMatches, mergeResults, setRailQuery, useRailSearch } from "../../state/railSearch.ts";
import { Icon } from "../ui/Icon.tsx";
import { RailThreadRow } from "./RailThreadRow.tsx";
import { RailEmpty } from "./RailEmpty.tsx";
import styles from "./RailSearch.module.css";

/** The rail's search field: instant local filter, server message search from two characters. */
export function RailSearchInput({ projectId }: { projectId: string | null }) {
  const query = useRailSearch((s) => s.query);
  return (
    <label className={styles.field}>
      <Icon name="search" size={14} className={styles.icon ?? ""} />
      <input
        className={styles.input}
        type="search"
        placeholder="Search threads"
        aria-label="Search threads"
        data-rail-search=""
        value={query}
        onChange={(e) => setRailQuery(e.target.value, projectId)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          // the composer would otherwise read this Escape as "stop the turn"
          e.preventDefault();
          e.stopPropagation();
          e.nativeEvent.stopImmediatePropagation();
          if (query !== "") setRailQuery("", projectId);
          else e.currentTarget.blur();
        }}
      />
    </label>
  );
}

/** While a query is active the groups give way to one "Results · n" list. */
export function RailSearchResults({
  query,
  projectId,
  projectIds,
  showProject,
}: {
  query: string;
  projectId: string | null;
  projectIds: readonly string[];
  showProject: boolean;
}) {
  const model = useModel((s) => s.model);
  const hits = useRailSearch((s) => s.hits);
  const hitsFor = useRailSearch((s) => s.hitsFor);
  const loading = useRailSearch((s) => s.loading);
  const rows = mergeResults(model, localMatches(model, query, projectIds), { hits, hitsFor }, query, projectId);
  if (rows.length === 0) return loading ? <p className={styles.pending}>Searching…</p> : <RailEmpty kind="search" />;
  return (
    <section className={styles.results} aria-label="Search results">
      <div className={styles.head}>
        <span className={styles.label}>Results</span>
        <span className={styles.count}>{rows.length}</span>
      </div>
      <ul className={styles.list} aria-label="Results">
        {rows.map(({ thread, hit }) => (
          <RailThreadRow key={thread.id} thread={thread} siblings={[]} showProject={showProject} {...(hit ? { hit } : {})} />
        ))}
      </ul>
    </section>
  );
}
