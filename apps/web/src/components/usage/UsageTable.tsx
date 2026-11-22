import { useState } from "react";
import type { ProviderStatusDto, UsageRow } from "@tide/contracts";
import { formatTokens, formatUsd } from "../../lib/glassBox.ts";
import { instanceLabel } from "../../lib/vocab.ts";
import { Icon } from "../ui/Icon.tsx";
import { Pill } from "../ui/Pill.tsx";
import { cacheHitPct, groupByHarness, sumRows, totalTokens, type UsageTotals } from "./usageMath.ts";
import styles from "./Usage.module.css";

const reported = (t: UsageTotals): string => (t.costUsd === undefined ? "—" : formatUsd(t.costUsd));
const estimated = (t: UsageTotals): string => (t.estimatedUsd === undefined ? "—" : `≈${formatUsd(t.estimatedUsd)}`);

function Numbers({ t }: { t: UsageTotals }) {
  return (
    <>
      <td className={styles.num}>{formatTokens(t.inputTokens)}</td>
      <td className={styles.num}>{formatTokens(t.outputTokens)}</td>
      <td className={styles.num}>{formatTokens(t.cacheReadTokens)}</td>
      <td className={styles.num}>{formatTokens(t.cacheWriteTokens)}</td>
      <td className={styles.num}>{t.turns.toLocaleString("en-US")}</td>
      <td className={styles.num}>{reported(t)}</td>
      <td className={`${styles.num} ${styles.estimate}`}>{estimated(t)}</td>
    </>
  );
}

export function SourceChip({ source }: { source: UsageRow["source"] }) {
  return source === "tide" ? (
    <Pill tone="accent" title="Recorded directly by Tide">
      Tide
    </Pill>
  ) : (
    <Pill title="Outside Tide (from local harness logs)">Logs</Pill>
  );
}

/** The window at a glance: tokens, turns/calls, reported and estimated spend, in one card. */
export function UsageSummaryCards({ rows }: { rows: readonly UsageRow[] }) {
  const t = sumRows(rows);
  const groups = groupByHarness(rows);
  const cached = cacheHitPct(t);
  const hasExternal = rows.some((r) => r.source === "external");
  const reportedRows = rows.filter((r) => r.costUsd !== undefined).length;
  const reportedSub =
    reportedRows === 0
      ? "not reported by harness"
      : reportedRows < rows.length
        ? `partial · ${reportedRows} of ${rows.length} rows`
        : "harness reported";
  const cells: { label: string; value: string; sub?: string }[] = [
    {
      label: "Tokens",
      value: formatTokens(totalTokens(t)),
      ...(cached !== undefined ? { sub: `${cached}% cache read` } : {}),
    },
    {
      label: hasExternal ? "Turns / calls" : "Turns",
      value: t.turns.toLocaleString("en-US"),
      sub: hasExternal
        ? `Tide turns + log API calls · ${groups.length} ${groups.length === 1 ? "harness" : "harnesses"}`
        : `${groups.length} ${groups.length === 1 ? "harness" : "harnesses"}`,
    },
    {
      label: "Reported",
      value: reported(t),
      sub: reportedSub,
    },
    {
      label: "Estimated",
      value: estimated(t),
      sub: "API list estimate",
    },
  ];
  return (
    <dl className={styles.summary} aria-label="Totals">
      {cells.map((c) => (
        <div key={c.label} className={styles.stat}>
          <dt className={styles.statLabel}>{c.label}</dt>
          <dd className={styles.statValue}>{c.value}</dd>
          {c.sub !== undefined ? <dd className={styles.statSub}>{c.sub}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

/** Harness → model, with the source of each row, collapsible harness groups, subtotals and a grand total. */
export function UsageTable({ rows, providers }: { rows: readonly UsageRow[]; providers: readonly ProviderStatusDto[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (rows.length === 0) return <p className={styles.note}>No turns in this window.</p>;
  const groups = groupByHarness(rows);
  const total = sumRows(rows);
  const grandTokens = totalTokens(total);
  const defaultOpen = groups.length === 1;
  const isOpen = (id: string): boolean => expanded[id] ?? defaultOpen;
  const allOpen = groups.every((g) => isOpen(g.id));

  const toggleGroup = (id: string): void => setExpanded((prev) => ({ ...prev, [id]: !(prev[id] ?? defaultOpen) }));
  const toggleAll = (): void => {
    const next = !allOpen;
    setExpanded(Object.fromEntries(groups.map((g) => [g.id, next])));
  };

  return (
    <div className={styles.card}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">
              <span>Harness / model</span>
              {groups.length > 1 ? (
                <button type="button" className={styles.expandAll} onClick={toggleAll}>
                  {allOpen ? "Collapse all" : "Expand all"}
                </button>
              ) : null}
            </th>
            <th scope="col">Source</th>
            <th scope="col" className={styles.num}>In</th>
            <th scope="col" className={styles.num}>Out</th>
            <th scope="col" className={styles.num}>Cache read</th>
            <th scope="col" className={styles.num}>Cache write</th>
            <th
              scope="col"
              className={styles.num}
              title="Tide rows count user turns; harness log rows count individual model API calls"
            >
              {rows.some((r) => r.source === "external") ? "Turns / calls" : "Turns"}
            </th>
            <th scope="col" className={styles.num}>Reported</th>
            <th scope="col" className={styles.num}>Estimated</th>
          </tr>
        </thead>
        {groups.map((group) => {
          const open = isOpen(group.id);
          const label = instanceLabel(providers, group.id);
          const share = grandTokens > 0 ? Math.round((totalTokens(group.totals) / grandTokens) * 100) : 0;
          return (
            <tbody key={group.id}>
              <tr className={styles.groupRow}>
                <th scope="row" aria-label={label}>
                  <button
                    type="button"
                    className={styles.groupToggle}
                    aria-expanded={open}
                    onClick={() => toggleGroup(group.id)}
                  >
                    <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
                    <span>{label}</span>
                    {groups.length > 1 && share > 0 ? <span className={styles.shareMeta}>{share}%</span> : null}
                  </button>
                </th>
                <td className={styles.groupCount}>
                  {open ? "" : `${group.rows.length} ${group.rows.length === 1 ? "row" : "rows"}`}
                </td>
                <Numbers t={group.totals} />
              </tr>
              {open
                ? group.rows.map((row, i) => (
                    <tr key={`${row.model ?? ""}|${row.source}|${i}`}>
                      <td className={styles.model}>{row.model ?? "default model"}</td>
                      <td>
                        <SourceChip source={row.source} />
                      </td>
                      <Numbers t={sumRows([row])} />
                    </tr>
                  ))
                : null}
            </tbody>
          );
        })}
        <tfoot>
          <tr className={styles.totalRow}>
            <th scope="row">Total</th>
            <td />
            <Numbers t={total} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
