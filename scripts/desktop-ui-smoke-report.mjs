// Verdicts and report output for scripts/desktop-ui-smoke.mjs. A snapshot's verdict has a basis:
// "cdp" (in-page checks over the debugging port, authoritative when available) or "os-evidence"
// (window pixels + the webview's connection to tide-server, used when CDP never attached).
import fs from "node:fs";
import path from "node:path";
import { isAppOrigin } from "./desktop-ui-smoke-cdp.mjs";
import { pixelLine } from "./desktop-ui-smoke-png.mjs";
import { connectionLine, evidenceLines } from "./desktop-ui-smoke-win.mjs";

const BOOT_GATE_ALERT = "Could not reach the Tide server";

/** Hides session secrets in any text that may hold a URL. */
export function redact(text) {
  return String(text).replace(/([?&](?:token|wsTicket)=)[\w.~%+=/-]*/g, "$1REDACTED");
}

export function cdpVerdict(snap) {
  const page = snap.page ?? {};
  const url = page.href ?? snap.mainUrl;
  const reasons = [];
  if (page.error) reasons.push(`page probe failed: ${page.error}`);
  if (!isAppOrigin(url)) reasons.push(`main frame not on the app origin (${url})`);
  if (!(page.rootChildren >= 1)) reasons.push(`#root children: ${page.rootChildren ?? "none"}`);
  if (!page.bodyText) reasons.push("body text empty");
  if ((page.alerts ?? []).some((a) => a.includes(BOOT_GATE_ALERT))) reasons.push(`alert: ${BOOT_GATE_ALERT}`);
  if (snap.counts?.crashes > 0) reasons.push("target crashed");
  return { rendered: reasons.length === 0, basis: "cdp", reasons };
}

/**
 * Rendered = the window's content area is not near-uniform AND the connection check is not false
 * (true passes; null — query impossible — leaves the verdict to the pixels, with a note).
 */
export function osVerdict({ pixels, connection }) {
  const reasons = [];
  const notes = [];
  if (!pixels) reasons.push("no pixel evidence (no desktop capture on this platform)");
  else if (pixels.error) reasons.push(`no pixel evidence: ${pixels.error}`);
  else if (!pixels.pass) {
    reasons.push(`window content is near-uniform: ${(pixels.differentFraction * 100).toFixed(2)}% of pixels differ from ${pixels.dominant}, ${pixels.distinctColours} distinct colours`);
  }
  const connected = connection?.connected ?? null;
  if (connected === false) {
    reasons.push(`no msedgewebview2 process holds an established connection to tide-server port ${connection.serverPort}`);
  } else if (connected === null) {
    notes.push(`webview connection unknown (${connection?.error ?? connection?.skipped ?? "query not made"}): verdict rests on pixels alone`);
  }
  return { rendered: reasons.length === 0, basis: "os-evidence", reasons, notes };
}

function cdpSnapshotLines(s) {
  const p = s.page ?? {};
  const sw = p.serviceWorker ?? {};
  const lines = [
    `   url: ${p.href ?? s.mainUrl}`,
    `   root children: ${p.rootChildren ?? "n/a"}  readyState: ${p.readyState ?? "n/a"}  secure: ${p.isSecureContext ?? "n/a"}`,
    `   alerts: ${JSON.stringify(p.alerts ?? [])}`,
    `   service workers: ${sw.count ?? (sw.error || (sw.unavailable ? "unavailable" : "n/a"))}  controlled: ${sw.controlled ?? "n/a"}  caches: ${JSON.stringify(p.caches ?? null)}`,
    `   console errors so far: ${s.counts?.consoleErrors ?? "n/a"}  exceptions: ${s.counts?.exceptions ?? "n/a"}  failed requests: ${s.counts?.failedRequests ?? "n/a"}`,
    `   body: ${(p.bodyText ?? "").slice(0, 200)}`,
  ];
  if (p.error) lines.push(`   probe error: ${p.error}`);
  return lines;
}

function osSnapshotLines(s) {
  return [
    `   CDP unavailable: ${s.cdpReason}`,
    `   screenshot: ${s.screenshot ?? "none"} @ ${s.t} ms`,
    `   ${pixelLine(s.pixels)}`,
    `   ${connectionLine(s.connection)}`,
    ...(s.verdict.notes ?? []).map((n) => `   note: ${n}`),
  ];
}

function purgeLines(purge) {
  if (!purge) return [];
  if (purge.error && !purge.path) return [`purge before this launch: ERROR ${purge.error}`];
  const gone = purge.processesGone;
  return [
    `purge before this launch: ${purge.path} existed=${purge.existed} deleted=${purge.deleted}` +
      `${purge.error ? ` error=${purge.error}` : ""} (previous processes gone: ${gone?.gone ?? "n/a"}${gone?.killed?.length ? `, killed ${gone.killed.join(", ")}` : ""})`,
  ];
}

const stat = (name, st) => `${name} ${st?.files ?? 0} files ${st?.bytes ?? 0} B`;

/** One compact line: what a launch left in the WebView2 profile after it was killed. */
function profileAfterLine(p) {
  if (!p) return null;
  if (p.error) return `profile after: ${p.error}`;
  const sw = p.serviceWorker ?? {};
  const swText = sw.exists
    ? `Service Worker yes — ${["Database", "ScriptCache", "CacheStorage"].map((n) => stat(n, sw.parts?.[n])).join(", ")}`
    : "Service Worker no";
  return `profile after: ${swText}; ${stat("Local Storage", p.localStorage)}`;
}

/** The Service Worker state a launch left, for the next launch's row in the table. */
function swLeftText(p) {
  if (!p) return "n/a (not recorded)";
  if (p.error) return `n/a (${p.error})`;
  const sw = p.serviceWorker ?? {};
  if (!sw.exists) return "no Service Worker dir";
  const sc = sw.parts?.ScriptCache?.files ?? 0;
  return `${sc > 0 ? "registered" : "not registered"}: ScriptCache ${sc} files, CacheStorage ${sw.parts?.CacheStorage?.bytes ?? 0} B`;
}

function purgeCell(purge) {
  if (!purge) return "no";
  if (purge.error && !purge.path) return "ERROR";
  return purge.deleted ? "yes" : purge.existed ? "FAILED" : "yes (absent)";
}

/** One row per launch: purged before? / Service Worker left by the previous launch / verdict. */
function launchTable(rounds) {
  const rows = rounds.map((r, i) => {
    const verdict = r.snapshots.length
      ? r.snapshots.map((s) => `${s.verdict.rendered ? "RENDERED" : "NOT RENDERED"} (${s.verdict.basis ?? "cdp"})`).join(", ")
      : "no snapshot";
    const prev = r.name === "attach" ? "n/a" : i === 0 ? "fresh install" : swLeftText(rounds[i - 1].profileAfter);
    return [r.name, purgeCell(r.purge), prev, verdict];
  });
  const head = ["launch", "purged before", "Service Worker left by previous launch", "verdict"];
  const width = head.map((h, c) => Math.max(h.length, ...rows.map((row) => row[c].length)));
  const fmt = (row) => `   ${row.map((v, c) => (c === row.length - 1 ? v : v.padEnd(width[c]))).join("  ")}`;
  return [fmt(head), fmt(width.map((w) => "-".repeat(w))), ...rows.map(fmt)];
}

export function summarize(report, version) {
  const lines = [`desktop-ui-smoke ${version}  ${report.platform}  ${report.startedAt}`];
  if (report.exe) lines.push(`app: ${report.exe}`);
  if (report.error) lines.push(`SCRIPT ERROR: ${report.error}`);
  for (const r of report.rounds) {
    lines.push("", `== ${r.name} ==`);
    lines.push(...purgeLines(r.purge));
    if (r.appOrigin) lines.push(`app origin: ${r.appOrigin.reached ? `reached${r.appOrigin.ms === null ? "" : ` at ${r.appOrigin.ms} ms`}` : "NOT reached"} (url ${r.appOrigin.url})`);
    for (const n of r.notes) lines.push(`note: ${n}`);
    lines.push(...evidenceLines(r));
    const after = profileAfterLine(r.profileAfter);
    if (after) lines.push(after);
    for (const s of r.snapshots) {
      const basis = s.verdict.basis ?? "cdp";
      lines.push(`-- ${s.label}: ${s.verdict.rendered ? "RENDERED" : "NOT RENDERED"} (basis: ${basis})`);
      lines.push(...(basis === "os-evidence" ? osSnapshotLines(s) : cdpSnapshotLines(s)));
      if (!s.verdict.rendered) lines.push(`   why: ${s.verdict.reasons.join("; ")}`);
    }
    const ev = r.events;
    const problems = [
      ...ev.console.filter((c) => c.type === "error").map((c) => `[${c.t} ms] console.error: ${c.text}${c.source ? ` (${c.source})` : ""}`),
      ...ev.exceptions.map((x) => `[${x.t} ms] exception: ${x.description ?? x.text} (${x.url}:${x.line})`),
      ...ev.failedRequests.map((f) => `[${f.t} ms] request failed: ${f.url} ${f.errorText}${f.blockedReason ? ` blocked=${f.blockedReason}` : ""}${f.canceled ? " canceled" : ""}`),
      ...ev.crashes.map((c) => `[${c.t} ms] TARGET CRASHED`),
    ];
    if (r.timings?.firstAttachMs != null || problems.length) {
      lines.push(`first problems (${Math.min(problems.length, 20)} of ${problems.length}):`, ...problems.slice(0, 20).map((l) => `   ${l}`));
    }
  }
  if (report.profile) {
    const p = report.profile;
    lines.push("", `webview2 profile: ${p.error ?? `${p.path} (full listing of Default in report.json)`}`);
  }
  lines.push("", "by launch:", ...launchTable(report.rounds));
  lines.push("", `VERDICT: ${report.verdict.pass ? "PASS" : "FAIL"}`);
  return redact(lines.join("\n")) + "\n";
}

export function writeOutputs(report, outDir, version) {
  fs.mkdirSync(outDir, { recursive: true });
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, "report.json"), redact(JSON.stringify(report, null, 2)));
  const summary = summarize(report, version);
  fs.writeFileSync(path.join(outDir, "summary.txt"), summary);
  process.stdout.write(summary);
}
