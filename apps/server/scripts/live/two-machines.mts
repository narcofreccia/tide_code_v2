// Two-server live check: repo identity, ensure/clone on B, branch push + merge on B, base status + pull on A, pairing/revoke, discovery.
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { WsTestClient } from "../../src/rpc/testing/wsClient.ts";

const S = process.env.S!;
const tok = (h: string) => (JSON.parse(readFileSync(`${S}/${h}/server.json`, "utf8")) as { token: string }).token;
const A = await WsTestClient.open(`ws://127.0.0.1:3821/ws?token=${tok("home1")}`);
const B = await WsTestClient.open(`ws://127.0.0.1:3822/ws?token=${tok("home2")}`);
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = (s: string) => console.log(`\n== ${s}`);

// repos
const L = `${S}/lanb`; mkdirSync(`${L}/A`, { recursive: true }); mkdirSync(`${L}/B`, { recursive: true });
git(L, "init", "-q", "--bare", "origin.git");
git(`${L}/A`, "clone", "-q", `${L}/origin.git`, "repo");
writeFileSync(`${L}/A/repo/a.txt`, "hello\n"); git(`${L}/A/repo`, "add", "."); git(`${L}/A/repo`, "commit", "-qm", "init"); git(`${L}/A/repo`, "push", "-q", "-u", "origin", "HEAD:main"); git(`${L}/A/repo`, "branch", "-q", "-M", "main");

step("A: project.create → repo identity");
const pa = await A.call<any>("orchestration.dispatch", { command: { type: "project.create", title: "lanb", rootPath: `${L}/A/repo` } });
const projA = pa.events.find((e: any) => e.event.type === "project.created").event.project;
console.log("repo:", JSON.stringify(projA.repo));

step("B: projectsDir setting + project.ensure (clone)");
await B.call("settings.set", { patch: { environment: { projectsDir: `${L}/B` }, git: { pushThreadBranches: "on-merge-request" } } });
const ens = await B.call<any>("project.ensure", { repo: { remoteUrl: projA.repo.remoteUrl, cloneUrl: projA.repo.cloneUrl, defaultBranch: projA.repo.defaultBranch }, title: "lanb" });
console.log("ensure:", JSON.stringify(ens));
const ens2 = await B.call<any>("project.ensure", { repo: { remoteUrl: projA.repo.remoteUrl, cloneUrl: projA.repo.cloneUrl, defaultBranch: projA.repo.defaultBranch }, title: "lanb" });
console.log("ensure again (reuse):", JSON.stringify(ens2));

step("B: thread with worktree, commit in it, thread.merge → base pushed");
const tb = await B.call<any>("orchestration.dispatch", { command: { type: "thread.create", projectId: ens.projectId, provider: "claude", mode: "auto", useWorktree: true, title: "work on B" } });
const threadB = tb.events.find((e: any) => e.event.type === "thread.created").event.thread.id;
let wt: string | undefined;
for (let i = 0; i < 30 && !wt; i++) { await sleep(500); const m = await B.call<any>("model.get", {}); wt = m.threads[threadB].worktreePath; }
console.log("worktree:", wt);
appendFileSync(`${wt}/a.txt`, "from B\n"); git(wt!, "add", "."); git(wt!, "commit", "-qm", "from B");
await B.call("orchestration.dispatch", { command: { type: "thread.merge", threadId: threadB } });
let mB: any;
for (let i = 0; i < 60; i++) { await sleep(500); mB = await B.call<any>("model.get", {}); const t = mB.threads[threadB]; if (t.mergedAt !== undefined || t.merge?.status === "error" || t.merge?.status === "conflicted") break; }
const tB = mB.threads[threadB];
console.log("merge:", JSON.stringify(tB.merge), "settled:", tB.settleReason, "remoteBranch:", tB.remoteBranch, "pushedSha:", tB.pushedSha?.slice(0, 7));
console.log("origin main log:", git(`${L}/origin.git`, "log", "--oneline", "main"));
console.log("origin branches:", git(`${L}/origin.git`, "branch", "--list").replace(/\s+/g, " "));

step("A: vcs.baseStatus (behind) → vcs.pullBase → in sync");
console.log("baseStatus:", JSON.stringify(await A.call("vcs.baseStatus", { projectId: projA.id, refresh: true })));
console.log("pullBase:", JSON.stringify(await A.call("vcs.pullBase", { projectId: projA.id })));
console.log("A main:", git(`${L}/A/repo`, "log", "--oneline", "-1"), "| baseStatus:", JSON.stringify(await A.call("vcs.baseStatus", { projectId: projA.id, refresh: true })));

step("A: dirty main → pullBase refused");
appendFileSync(`${L}/A/repo/a.txt`, "dirty\n");
console.log("pullBase dirty →", JSON.stringify(await A.expectError("vcs.pullBase", { projectId: projA.id })));
git(`${L}/A/repo`, "checkout", "--", "a.txt");

step("B: pairing mints a device token; list; revoke closes the socket 4401");
const code = await B.call<any>("env.pairingCode", {});
const pair = await (await fetch("http://127.0.0.1:3822/api/auth/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code.code, name: "smoke laptop" }) })).json() as any;
console.log("pair:", { clientId: pair.clientId, tokenIsMaster: pair.token === tok("home2") });
const ticket = await (await fetch("http://127.0.0.1:3822/api/auth/ws-ticket", { method: "POST", headers: { authorization: `Bearer ${pair.token}` } })).json() as any;
const D = await WsTestClient.open(`ws://127.0.0.1:3822/ws?wsTicket=${ticket.ticket}`);
console.log("device socket open; clients:", JSON.stringify((await D.call<any>("env.clients.list", {})).clients.map((c: any) => `${c.name}${c.id === pair.clientId ? "*" : ""}`)));
const closed = D.closed;
console.log("revoke:", JSON.stringify(await B.call("env.clients.revoke", { id: pair.clientId })), "→ device closed:", JSON.stringify(await closed));
const again = await fetch("http://127.0.0.1:3822/api/auth/ws-ticket", { method: "POST", headers: { authorization: `Bearer ${pair.token}` } });
console.log("revoked token buys a ticket?", again.status);

step("A: env.discover finds B");
const disc = await A.call<any>("env.discover", { timeoutMs: 2000 });
console.log("discover:", disc.enabled, JSON.stringify(disc.peers.map((p: any) => `${p.name}@${p.host}:${p.port}`)));

A.close(); B.close();
