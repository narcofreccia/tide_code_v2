import { quotaHoldText, type QuotaView } from "@tide/client";
import type { Quota, QuotaScope } from "@tide/contracts";
import { newId } from "@tide/contracts";
import { dispatchOrToast } from "./dispatchOrToast.ts";
import { relativeUntil } from "./relativeTime.ts";
import { formatUntil } from "./turnActions.ts";

// R20: wording and actions for usage quotas, shared by the meter, the chip, the composer and Mission Control.

/** `resets in 2d`, or undefined when the window end is not known. */
export function quotaResetText(view: QuotaView, now: number = Date.now()): string | undefined {
  return view.resetsAt === undefined ? undefined : `resets ${relativeUntil(view.resetsAt, now)}`;
}

/** `Project quota reached (≈ 31% of the weekly window, cap 30%) · resets in 2d`. */
export function quotaBlockText(view: QuotaView, now: number = Date.now()): string {
  const reset = quotaResetText(view, now);
  return reset === undefined ? quotaHoldText(view) : `${quotaHoldText(view)} · ${reset}`;
}

/** The meter's short label: `quota 40%`, `quota · measuring`. */
export function quotaShortText(view: QuotaView): string {
  return view.usedPct === undefined ? "quota · measuring" : `quota ${Math.round(view.usedPct)}%`;
}

/** The tooltip: the figure, the cap, the policy, the reset and any lift, one per line. */
export function quotaTitle(view: QuotaView, now: number = Date.now()): string {
  const lines = [
    view.figureText ?? "Measuring. The figure appears after the next measurement.",
    view.capText.charAt(0).toUpperCase() + view.capText.slice(1),
    view.quota.onExceed === "hold" ? "At the cap: hold new turns" : "At the cap: warn only",
  ];
  const reset = quotaResetText(view, now);
  if (reset !== undefined) lines.push(reset.charAt(0).toUpperCase() + reset.slice(1));
  if (view.liftedUntil !== undefined) lines.push(`Lifted until ${formatUntil(view.liftedUntil, now)}`);
  if (view.approx) lines.push("Includes estimated prices or spend Tide cannot see");
  return lines.join("\n");
}

export function setQuota(scope: QuotaScope, id: string, quota: Quota | undefined): void {
  dispatchOrToast(quota === undefined ? "Removing the quota" : "Saving the quota", {
    type: "quota.set",
    commandId: newId(),
    scope,
    id,
    ...(quota === undefined ? {} : { quota }),
  });
}

export function liftQuota(scope: QuotaScope, id: string): void {
  dispatchOrToast("Lifting the quota", { type: "quota.lift", commandId: newId(), scope, id });
}
