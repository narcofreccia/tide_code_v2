// WebView2 profile helpers for scripts/desktop-ui-smoke.mjs: find the app's user data dir from a
// captured msedgewebview2 command line, delete its Service Worker directory before a launch
// (--purge-sw-before), and list the profile after the last launch to show whether a worker registered.
import fs from "node:fs";
import path from "node:path";
import { winWaitGone } from "./desktop-ui-smoke-win.mjs";

const DELETE_ATTEMPTS = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** --user-data-dir="…" (or unquoted) from the newest msedgewebview2 command line in `rounds`. */
export function userDataDir(rounds) {
  for (const r of [...rounds].reverse()) {
    for (const e of [...(r.win?.processes ?? [])].reverse()) {
      for (const p of e.processes ?? []) {
        if (!/^msedgewebview2\.exe$/i.test(p.name ?? "")) continue;
        const m = /--user-data-dir=(?:"([^"]+)"|(\S+))/.exec(p.commandLine ?? "");
        if (m) return m[1] ?? m[2];
      }
    }
  }
  return null;
}

/** Removes `dir` recursively, retrying while a dying process still holds a file. */
export async function deleteDir(dir) {
  const existed = fs.existsSync(dir);
  let error = null;
  let attempts = 0;
  while (existed && attempts < DELETE_ATTEMPTS) {
    attempts++;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      error = null;
      break;
    } catch (e) {
      error = String(e?.message ?? e);
      await sleep(1000);
    }
  }
  return { path: dir, existed, deleted: existed && !fs.existsSync(dir), attempts, error };
}

/** Before a launch: make sure the previous launch is gone, then delete <profile>\Default\Service Worker. */
export async function purgeServiceWorker(earlierRounds, exe) {
  const dir = userDataDir(earlierRounds);
  if (!dir) return { error: "no --user-data-dir on any msedgewebview2 command line captured in earlier launches" };
  const processesGone = await winWaitGone(path.basename(exe), dir);
  return { userDataDir: dir, processesGone, ...(await deleteDir(path.join(dir, "Default", "Service Worker"))) };
}

function treeBytes(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    try {
      total += fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size;
    } catch {}
  }
  return total;
}

/** Shallow listing of <profile>\Default; for Service Worker, its children with sizes. Never throws. */
export function listProfile(dir) {
  if (!dir) return { error: "no --user-data-dir on any msedgewebview2 command line captured" };
  const def = path.join(dir, "Default");
  try {
    const entries = fs.readdirSync(def, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    const swDir = path.join(def, "Service Worker");
    const serviceWorker = { path: swDir, exists: fs.existsSync(swDir) };
    if (serviceWorker.exists) {
      serviceWorker.children = fs.readdirSync(swDir, { withFileTypes: true }).map((e) => {
        const full = path.join(swDir, e.name);
        let bytes = null;
        try { bytes = e.isDirectory() ? treeBytes(full) : fs.statSync(full).size; } catch {}
        return { name: e.name, dir: e.isDirectory(), bytes };
      });
      serviceWorker.totalBytes = serviceWorker.children.reduce((n, c) => n + (c.bytes ?? 0), 0);
    }
    return { path: def, entries, serviceWorker };
  } catch (e) {
    return { path: def, error: `cannot list ${def}: ${e?.message ?? e}` };
  }
}
