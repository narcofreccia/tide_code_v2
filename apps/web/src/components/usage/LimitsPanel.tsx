import { selectProviderRateLimits } from "@tide/client";
import type { RateLimit } from "@tide/contracts";
import { LIMIT_WINDOWS, WINDOW_LABELS, isStaleThreadRateLimit, selectInstanceLimits, usedPct, type InstanceLimits } from "../../lib/limits.ts";
import { relativeTime, relativeUntil } from "../../lib/relativeTime.ts";
import { instanceLabel } from "../../lib/vocab.ts";
import { useModel } from "../../state/model.ts";
import { loadProviders, useProvidersSnapshot, useProvidersStore } from "../../state/providers.ts";
import { LimitedSection } from "../mission/LimitedSection.tsx";
import { Button } from "../ui/Button.tsx";
import { Pill } from "../ui/Pill.tsx";
import { rateLimitTitle } from "../ui/RateLimitBadge.tsx";
import styles from "./Usage.module.css";

const WINDOW_NAMES = { "5h": "5-hour window", wk: "Weekly window", other: "Limit" } as const;

function windowHeading(window: keyof typeof WINDOW_NAMES, limit: RateLimit): string {
  if (window !== "other") return WINDOW_NAMES[window];
  const note = limit.note?.trim() ?? "";
  if (note.startsWith("extra_usage")) return "Extra usage";
  if (note.startsWith("seven_day_opus")) return "Opus weekly";
  if (note.startsWith("seven_day_sonnet")) return "Sonnet weekly";
  const scoped = /^([A-Za-z0-9._-]+)\s+\d+%/.exec(note)?.[1];
  if (scoped && scoped !== "five_hour" && scoped !== "seven_day") return `${scoped} limit`;
  return WINDOW_NAMES.other;
}

function meterToneClass(limit: RateLimit, used: number | undefined): string {
  if (limit.status === "limited") return styles.meterLimited ?? "";
  if (limit.status === "warning" || (used !== undefined && used >= 80)) return styles.meterWarn ?? "";
  return styles.meterOk ?? "";
}

function WindowLine({ window, limit }: { window: keyof typeof WINDOW_NAMES; limit: RateLimit }) {
  const used = usedPct(limit);
  const value = limit.status === "limited" ? 100 : (used ?? 0);
  return (
    <li className={styles.window} title={rateLimitTitle(limit)}>
      <div className={styles.windowHead}>
        <span className={styles.windowName}>{windowHeading(window, limit)}</span>
        <span className={styles.windowRight}>
          <span className={styles.windowText}>
            {limit.status === "limited" ? "limited" : used === undefined ? "no number reported" : `${Math.round(used)}% used`}
            {limit.resetsAt === undefined ? "" : ` · resets ${relativeUntil(limit.resetsAt)}`}
          </span>
          {limit.status === "ok" ? null : <Pill tone={limit.status === "limited" ? "limited" : "needs"}>{limit.status}</Pill>}
        </span>
      </div>
      <meter
        className={`${styles.meter} ${meterToneClass(limit, used)}`}
        min={0}
        max={100}
        low={70}
        high={90}
        optimum={0}
        value={value}
        aria-label={`${WINDOW_LABELS[window]} used`}
      />
    </li>
  );
}

/**
 * Every harness's last reported limit (the subscription is shared across threads, so the
 * newest report per window wins), then the threads parked on a limit. Rendered at the top of
 * the Usage page because it reads synchronously from the model with zero layout shift.
 */
export function LimitsPanel() {
  const model = useModel((s) => s.model);
  const providers = useProvidersSnapshot();
  const refreshing = useProvidersStore((s) => s.loading);
  const instances = selectInstanceLimits(model, Date.now(), providers);
  // a kind whose latest report carried no window still shows through the provider rollup
  const byKind = selectProviderRateLimits(model);
  const seen = new Set(instances.map((i) => i.provider));
  const extra: InstanceLimits[] = Object.entries(byKind)
    .filter(([kind, limit]) => !seen.has(kind as InstanceLimits["provider"]) && limit !== undefined && !isStaleThreadRateLimit(kind as InstanceLimits["provider"], limit))
    .map(([kind, limit]) => ({ id: kind, provider: kind as InstanceLimits["provider"], windows: { other: limit as RateLimit } }));
  const all = [...instances, ...extra];
  const quiet = providers.filter((p) => p.installed && p.loggedIn && !all.some((i) => i.id === (p.id || p.kind)));

  return (
    <section className={styles.panel} aria-label="Limits">
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>Limits</h3>
        <div className={styles.repairActions}>
          {quiet.length > 0 && all.length > 0 ? (
            <span className={styles.quietInline}>
              No limit reported yet: {quiet.map((p) => instanceLabel(providers, p.id || p.kind)).join(", ")}
            </span>
          ) : null}
          {providers.length > 0 ? (
            <Button variant="quiet" disabled={refreshing} onClick={() => loadProviders(true)}>
              {refreshing ? "Refreshing…" : "Refresh"}
            </Button>
          ) : null}
        </div>
      </div>
      {all.length === 0 ? (
        <div className={styles.limitEmpty}>
          <p className={styles.note}>No harness has reported a limit yet; limits appear here as turns run.</p>
          {quiet.length > 0 ? (
            <ul className={styles.quietList}>
              {quiet.map((p) => (
                <li key={p.id || p.kind} className={styles.quietItem}>
                  <span className={styles.instanceName}>{instanceLabel(providers, p.id || p.kind)}</span>
                  <span className={styles.note}>no limit reported yet</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <ul className={styles.limitGrid}>
          {all.map((entry) => {
            const latestAt = Math.max(
              0,
              ...Object.values(entry.windows).map((w) => w?.at ?? 0),
            );
            return (
              <li key={entry.id} className={styles.limitCard}>
                <div className={styles.limitCardHead}>
                  <span className={styles.instanceName}>{instanceLabel(providers, entry.id)}</span>
                  {latestAt > 0 ? (
                    <span
                      className={styles.quietInline}
                      title={`Last rate-limit event received from ${instanceLabel(providers, entry.id)} at ${new Date(latestAt).toLocaleString()} (updates when a turn runs in Tide)`}
                    >
                      updated {relativeTime(latestAt)}
                    </span>
                  ) : null}
                </div>
                <ul className={styles.windows}>
                  {LIMIT_WINDOWS.map((w) => {
                    const limit = entry.windows[w];
                    return limit ? <WindowLine key={w} window={w} limit={limit} /> : null;
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
      <LimitedSection />
    </section>
  );
}
