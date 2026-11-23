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

/** Recursive file count and bytes under `dir`; { files: 0, bytes: 0, exists: false } when absent. */
function treeStats(dir) {
  const out = { exists: fs.existsSync(dir), files: 0, bytes: 0 };
  if (!out.exists) return out;
  try {
    if (!fs.statSync(dir).isDirectory()) return { ...out, files: 1, bytes: fs.statSync(dir).size };
    for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue;
      out.files++;
      try {
        out.bytes += fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size;
      } catch {}
    }
  } catch (e) {
    out.error = String(e?.message ?? e);
  }
  return out;
}

const SW_PARTS = ["Database", "ScriptCache", "CacheStorage"];

/**
 * The profile state a launch leaves behind: Service Worker (children with sizes, and file
 * count/bytes of Database, ScriptCache and CacheStorage) plus Local Storage. Never throws.
 */
export function profileState(dir) {
  if (!dir) return { error: "no --user-data-dir on any msedgewebview2 command line captured" };
  const def = path.join(dir, "Default");
  try {
    const swDir = path.join(def, "Service Worker");
    const serviceWorker = { path: swDir, exists: fs.existsSync(swDir) };
    if (serviceWorker.exists) {
      serviceWorker.children = fs.readdirSync(swDir, { withFileTypes: true }).map((e) => {
        const st = treeStats(path.join(swDir, e.name));
        return { name: e.name, dir: e.isDirectory(), files: st.files, bytes: st.bytes };
      });
      serviceWorker.totalBytes = serviceWorker.children.reduce((n, c) => n + c.bytes, 0);
      serviceWorker.parts = Object.fromEntries(SW_PARTS.map((name) => [name, treeStats(path.join(swDir, name))]));
    }
    return { path: def, serviceWorker, localStorage: treeStats(path.join(def, "Local Storage")) };
  } catch (e) {
    return { path: def, error: `cannot read ${def}: ${e?.message ?? e}` };
  }
}

/** Shallow listing of <profile>\Default plus profileState(). Never throws. */
export function listProfile(dir) {
  const state = profileState(dir);
  if (state.error) return state;
  try {
    const entries = fs.readdirSync(state.path, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return { ...state, entries };
  } catch (e) {
    return { ...state, error: `cannot list ${state.path}: ${e?.message ?? e}` };
  }
}
