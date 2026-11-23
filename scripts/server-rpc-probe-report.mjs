// Report output for scripts/server-rpc-probe.mjs: rpc-probe-report.json (everything) and
// rpc-probe-summary.txt (one block per context). Every byte written goes through redact() from
// desktop-ui-smoke-report.mjs (?token= / ?wsTicket= in URLs) and then through the literal
// secrets this run saw (the server tokens and every ticket it bought).
import fs from "node:fs";
import path from "node:path";
import { redact } from "./desktop-ui-smoke-report.mjs";
import { folderLines, sampleLines } from "./server-rpc-probe-evidence.mjs";

export function redactAll(text, secrets) {
  let out = redact(text);
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("REDACTED");
  return out;
}

const OMIT = new Set(["child", "rpc", "token"]);
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

/** "OK" | "ERROR <code> <message>" | "HUNG after <n> s" | "CLOSED …" | "NOT RUN (…)" */
export function outcome(call) {
  if (!call) return "NOT RUN";
  if (call.skipped) return `NOT RUN (${call.skipped})`;
  if (call.status === "ok") return "OK";
  if (call.status === "error") return `ERROR ${call.error?.code ?? "?"} ${call.error?.message ?? ""}`.trim();
  if (call.status === "timeout") return `HUNG after ${Math.round(call.ms / 1000)} s${call.budgetCapped ? " (timeout cut by the probe's time budget)" : ""}`;
  if (call.status === "closed") return `CLOSED ${call.error?.message ?? ""}`.trim();
  return String(call.status);
}

function callLine(label, call) {
  const ms = call?.ms != null ? secs(call.ms).padStart(8) : "".padStart(8);
  return `  ${label.padEnd(34)} ${ms}  ${outcome(call)}`;
}

function initBlock(init) {
  const lines = [callLine(`project.init (${init.label})`, init.call)];
  lines.push(`      parentPath=${init.parentPath} name=${init.name}`);
  if (init.call?.status === "ok") lines.push(`      -> projectId=${init.call.result?.projectId} rootPath=${init.call.result?.rootPath}`);
  const hung = init.call && init.call.status !== "ok";
  if (hung) {
    for (const s of init.samples ?? []) {
      const h = s.health ? `health ${s.health.answered ? `answered ${s.health.status} in ${s.health.ms} ms` : `NO ANSWER (${s.health.error})`}` : "";
      const tree = (s.processes?.processes ?? []).filter((p) => p.inServerTree).map((p) => `${p.name}:${p.pid}`);
      lines.push(`      @${secs(s.t)} ${h}; server tree ${JSON.stringify(tree)}`);
      lines.push(...folderLines(s.folder, "        "));
    }
  }
  const a = init.after;
  if (a) {
    lines.push(`      after the call: socket ${a.socketState}${a.postInfo ? `; server.info sent after it: ${outcome(a.postInfo)} in ${secs(a.postInfo.ms)}` : ""}` +
      `${a.health ? `; /health ${a.health.answered ? "answered" : "NO ANSWER"}` : ""}`);
    lines.push(...folderLines(a.folder));
    if (hung) lines.push(...sampleLines(a.processes));
    if (hung && a.serverLogTail?.length) {
      lines.push("      server log tail:");
      lines.push(...a.serverLogTail.slice(-25).map((l) => `        | ${l.slice(0, 300)}`));
    }
  }
  for (const late of init.lateAnswers ?? []) lines.push(`      late answer after ${secs(late.afterMs)}: ${late.status} ${JSON.stringify(late.result ?? late.error).slice(0, 300)}`);
  return lines;
}

function contextBlock(c) {
  const lines = [`== context ${c.name} ==`];
  const l = c.launch;
  if (l) lines.push(`  launched ${l.kind}: ${l.exe} ${(l.args ?? []).join(" ")} (pid ${l.pid})`);
  lines.push(`  server: ${c.wsUrl ?? "unknown"}; server pid ${c.serverPid ?? "?"}; listening after ${c.listening?.ms != null ? secs(c.listening.ms) : "?"}; auth ${c.auth ?? "?"}${c.socket?.ok === false ? ` — socket FAILED: ${c.socket.error}` : ""}`);
  if (c.error) lines.push(`  ERROR: ${c.error}`);
  for (const call of c.calls ?? []) lines.push(callLine(call.label, call));
  for (const init of c.inits ?? []) lines.push(...initBlock(init));
  for (const call of c.followUps ?? []) lines.push(callLine(call.label, call));
  for (const n of c.notes ?? []) lines.push(`  note: ${n}`);
  for (const init of c.inits ?? []) lines.push(`${c.name} project.init${init.label === "profile" ? "" : ` (${init.label})`}: ${outcome(init.call)}`);
  if (!(c.inits ?? []).length) lines.push(`${c.name} project.init: NOT RUN`);
  return lines;
}

function gitBlock(g) {
  if (!g) return [];
  const lines = ["== git on this machine (run by the probe itself) =="];
  lines.push(`  where: ${g.where?.ok ? g.where.out.split(/\r?\n/).join(" | ") : `ERROR ${g.where?.error}`}`);
  lines.push(`  version: ${g.version?.ok ? g.version.out : `ERROR ${g.version?.error}`}`);
  for (const h of g.configHighlights ?? []) lines.push(`  config: ${h}`);
  for (const r of g.direct?.runs ?? []) {
    lines.push(`  direct: ${r.argv.join(" ")} -> exit ${r.exitCode}${r.signal ? ` signal ${r.signal}` : ""} in ${secs(r.ms)}${r.spawnError ? ` (${r.spawnError})` : ""}${r.stderr ? ` stderr: ${r.stderr.slice(0, 200)}` : ""}`);
  }
  if (g.direct?.error) lines.push(`  direct: ERROR ${g.direct.error}`);
  lines.push(...folderLines(g.direct?.after, "  "));
  return lines;
}

export function summarize(report) {
  const lines = [
    `server-rpc-probe ${report.script.version} — ${report.platform}, node ${report.node}, started ${report.startedAt}`,
    `budget ${report.budgetSec} s; finished after ${report.elapsedMs != null ? secs(report.elapsedMs) : "?"}${report.error ? `; SCRIPT ERROR: ${report.error.split("\n")[0]}` : ""}`,
    "",
    ...gitBlock(report.gitFacts),
    "",
  ];
  if (report.desktop) lines.push(`desktop folder: ${JSON.stringify(report.desktop)}`, "");
  for (const c of report.contexts ?? []) lines.push(...contextBlock(c), "");
  for (const c of report.cleanup ?? []) lines.push(`cleanup: ${c.path} ${c.removed ? "removed" : `NOT removed (${c.reason})`}`);
  lines.push(`verdict: ${report.verdict?.pass ? "PASS" : "FAIL"} (exit ${report.exitCode ?? "?"})`);
  return lines.join("\n") + "\n";
}

/** Writes both files; called after every step so a killed run still leaves what it had. */
export function writeOutputs(report, outDir, secrets) {
  fs.mkdirSync(outDir, { recursive: true });
  // live handles (child process, socket) and the raw token never reach the files
  const json = JSON.parse(JSON.stringify(report, (key, value) => (OMIT.has(key) ? undefined : value)));
  fs.writeFileSync(path.join(outDir, "rpc-probe-report.json"), redactAll(JSON.stringify(json, null, 2), secrets));
  fs.writeFileSync(path.join(outDir, "rpc-probe-summary.txt"), redactAll(summarize(json), secrets));
}
