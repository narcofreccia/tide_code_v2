import { selectProviderRateLimits } from "@tide/client";
import type { RateLimit } from "@tide/contracts";
import { LIMIT_WINDOWS, WINDOW_LABELS, selectInstanceLimits, usedPct, type InstanceLimits } from "../../lib/limits.ts";
import { relativeUntil } from "../../lib/relativeTime.ts";
import { instanceLabel } from "../../lib/vocab.ts";
import { useModel } from "../../state/model.ts";
import { useProvidersSnapshot } from "../../state/providers.ts";
import { LimitedSection } from "../mission/LimitedSection.tsx";
import { Pill } from "../ui/Pill.tsx";
import { rateLimitTitle } from "../ui/RateLimitBadge.tsx";
import styles from "./Usage.module.css";

const WINDOW_NAMES = { "5h": "5-hour window", wk: "Weekly window", other: "Limit" } as const;

function WindowLine({ window, limit }: { window: keyof typeof WINDOW_NAMES; limit: RateLimit }) {
  const used = usedPct(limit);
  return (
    <li className={styles.window} title={rateLimitTitle(limit)}>
      <span className={styles.windowName}>{WINDOW_NAMES[window]}</span>
      <meter
        className={styles.meter}
        min={0}
        max={100}
        low={70}
        high={90}
        optimum={0}
        value={limit.status === "limited" ? 100 : (used ?? 0)}
        aria-label={`${WINDOW_LABELS[window]} used`}
      />
      <span className={styles.windowText}>
        {limit.status === "limited" ? "limited" : used === undefined ? "no number reported" : `${Math.round(used)}% used`}
        {limit.resetsAt === undefined ? "" : ` · resets ${relativeUntil(limit.resetsAt)}`}
      </span>
      {limit.status === "ok" ? null : <Pill tone={limit.status === "limited" ? "limited" : "needs"}>{limit.status}</Pill>}
    </li>
  );
}

/**
 * Every harness's last reported limit (the subscription is shared across threads, so the
 * newest report per window wins), then the threads parked on a limit.
 */
export function LimitsPanel() {
  const model = useModel((s) => s.model);
  const providers = useProvidersSnapshot();
  const instances = selectInstanceLimits(model);
  // a kind whose latest report carried no window still shows through the provider rollup
  const byKind = selectProviderRateLimits(model);
  const seen = new Set(instances.map((i) => i.provider));
  const extra: InstanceLimits[] = Object.entries(byKind)
    .filter(([kind]) => !seen.has(kind as InstanceLimits["provider"]))
    .map(([kind, limit]) => ({ id: kind, provider: kind as InstanceLimits["provider"], windows: { other: limit as RateLimit } }));
  const all = [...instances, ...extra];
  const quiet = providers.filter((p) => p.installed && p.loggedIn && !all.some((i) => i.id === (p.id || p.kind)));

  return (
    <section className={styles.panel} aria-label="Limits">
      <h3 className={styles.sectionTitle}>Limits</h3>
      {all.length === 0 ? <p className={styles.note}>No harness has reported a limit yet; they report during turns.</p> : null}
      <ul className={styles.instances}>
        {all.map((entry) => (
          <li key={entry.id} className={styles.instance}>
            <span className={styles.instanceName}>{instanceLabel(providers, entry.id)}</span>
            <ul className={styles.windows}>
              {LIMIT_WINDOWS.map((w) => {
                const limit = entry.windows[w];
                return limit ? <WindowLine key={w} window={w} limit={limit} /> : null;
              })}
            </ul>
          </li>
        ))}
        {quiet.map((p) => (
          <li key={p.id || p.kind} className={styles.instance}>
            <span className={styles.instanceName}>{instanceLabel(providers, p.id || p.kind)}</span>
            <span className={styles.note}>no limit reported yet</span>
          </li>
        ))}
      </ul>
      <LimitedSection />
    </section>
  );
}
