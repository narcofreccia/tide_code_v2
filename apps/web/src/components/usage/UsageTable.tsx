import type { ProviderStatusDto, UsageRow } from "@tide/contracts";
import { formatTokens, formatUsd } from "../../lib/glassBox.ts";
import { instanceLabel } from "../../lib/vocab.ts";
import { Pill } from "../ui/Pill.tsx";
import { groupByHarness, sumRows, type UsageTotals } from "./usageMath.ts";
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
      <td className={styles.num}>{t.turns}</td>
      <td className={styles.num}>{reported(t)}</td>
      <td className={`${styles.num} ${styles.estimate}`}>{estimated(t)}</td>
    </>
  );
}

export function SourceChip({ source }: { source: UsageRow["source"] }) {
  return source === "tide" ? <Pill tone="accent">Tide</Pill> : <Pill>outside Tide (harness logs)</Pill>;
}

/** Harness → model, with the source of each row, a subtotal per harness and a grand total. */
export function UsageTable({ rows, providers }: { rows: readonly UsageRow[]; providers: readonly ProviderStatusDto[] }) {
  if (rows.length === 0) return <p className={styles.note}>No turns in this window.</p>;
  const groups = groupByHarness(rows);
  const total = sumRows(rows);
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Harness / model</th>
            <th scope="col">Source</th>
            <th scope="col" className={styles.num}>In</th>
            <th scope="col" className={styles.num}>Out</th>
            <th scope="col" className={styles.num}>Cache read</th>
            <th scope="col" className={styles.num}>Cache write</th>
            <th scope="col" className={styles.num}>Turns</th>
            <th scope="col" className={styles.num}>Reported</th>
            <th scope="col" className={styles.num}>Estimated</th>
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group.id}>
            <tr className={styles.groupRow}>
              <th scope="row">{instanceLabel(providers, group.id)}</th>
              <td />
              <Numbers t={group.totals} />
            </tr>
            {group.rows.map((row, i) => (
              <tr key={`${row.model ?? ""}|${row.source}|${i}`}>
                <td className={styles.model}>{row.model ?? "default model"}</td>
                <td>
                  <SourceChip source={row.source} />
                </td>
                <Numbers t={sumRows([row])} />
              </tr>
            ))}
          </tbody>
        ))}
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
