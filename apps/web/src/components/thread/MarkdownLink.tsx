import type { AnchorHTMLAttributes } from "react";
import { envOpt, envSshHost, isLocalEnv } from "../fleet/envView.ts";
import { editorUrl, launchEditorUrl, type EditorApp } from "../../lib/openInEditor.ts";
import { deviceLimitOf } from "../../state/deviceAccess.ts";
import { envOfThread, useEnvironments } from "../../state/environments.ts";
import { call, useModel } from "../../state/model.ts";
import { showToast } from "../../state/toast.ts";
import { useUi } from "../../state/ui.ts";
import { openFileTab } from "../../state/workbench.ts";

const ALLOWED_SCHEMES = new Set(["http", "https", "mailto", "file", "vscode", "cursor"]);

/**
 * Custom `urlTransform` for `react-markdown`: keeps `file:` and editor links intact (the
 * default `react-markdown` sanitizer wipes `file:` to `""`, turning them into `<a href="">`
 * links that reload the SPA) while still blocking `javascript:`, `vbscript:`, `data:`, etc.
 */
export function markdownUrlTransform(url: string): string {
  const trimmed = url.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return trimmed;
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (!schemeMatch) return trimmed; // relative or bare path
  const scheme = schemeMatch[1]!.toLowerCase();
  // Windows drive letter like `C:\...` or `C:/...`
  if (scheme.length === 1 && /^[a-zA-Z]:[\\/]/.test(trimmed)) return trimmed;
  return ALLOWED_SCHEMES.has(scheme) ? trimmed : "";
}

export interface ParsedFileLink {
  path: string;
  absolute: boolean;
  line?: number;
  column?: number;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Parses `file://...`, `/abs/path`, or `rel/path` with optional `#L12`, `#L12-L20`, or `:12:4`. */
export function parseFileLink(href: string): ParsedFileLink | undefined {
  const trimmed = href.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return undefined;

  let rawPath: string;
  let hash = "";
  let absolute = false;

  if (/^file:/i.test(trimmed)) {
    const hashIdx = trimmed.indexOf("#");
    const beforeHash = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
    hash = hashIdx >= 0 ? trimmed.slice(hashIdx + 1) : "";
    let body = beforeHash.replace(/^file:/i, "");
    if (body.startsWith("//localhost/")) body = body.slice("//localhost".length);
    else if (body.startsWith("///")) body = body.slice(2);
    else if (body.startsWith("//")) body = body.slice(1);
    // Windows `file:///C:/foo` → `C:/foo`
    if (/^\/[a-zA-Z]:[\\/]/.test(body)) body = body.slice(1);
    rawPath = safeDecode(body);
    absolute = rawPath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rawPath);
  } else {
    const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
    if (schemeMatch && !(schemeMatch[1]!.length === 1 && /^[a-zA-Z]:[\\/]/.test(trimmed))) return undefined;
    const hashIdx = trimmed.indexOf("#");
    const beforeHash = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
    hash = hashIdx >= 0 ? trimmed.slice(hashIdx + 1) : "";
    rawPath = safeDecode(beforeHash);
    absolute = rawPath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rawPath);
  }

  let line: number | undefined;
  let column: number | undefined;

  // `#L42`, `#L42-L60`, `#L42C5`, `#42`
  const hashLine = /^L?(\d+)(?:C(\d+)|-L?\d+)?$/i.exec(hash);
  if (hashLine) {
    line = Number(hashLine[1]);
    if (hashLine[2] !== undefined) column = Number(hashLine[2]);
  }

  // Trailing `:line` or `:line:col` on the path (preserving Windows drive `C:`)
  const suffix = /:(\d+)(?::(\d+))?$/.exec(rawPath);
  if (suffix && suffix.index > 1) {
    if (line === undefined) line = Number(suffix[1]);
    if (column === undefined && suffix[2] !== undefined) column = Number(suffix[2]);
    rawPath = rawPath.slice(0, suffix.index);
  }

  const cleaned = rawPath.replace(/^\.\//, "");
  if (cleaned === "") return undefined;
  return {
    path: cleaned,
    absolute,
    ...(line !== undefined && line > 0 ? { line } : {}),
    ...(column !== undefined && column > 0 ? { column } : {}),
  };
}

/** Returns `absPath` relative to `root`, or `undefined` when outside `root`. */
export function relativeToRoot(absPath: string, root: string | undefined): string | undefined {
  if (!root) return undefined;
  const normRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normPath = absPath.replace(/\\/g, "/");
  if (normRoot === "" || !normPath.startsWith(`${normRoot}/`)) return undefined;
  const rel = normPath.slice(normRoot.length + 1);
  return rel === "" ? undefined : rel;
}

function editorFileUrl(app: EditorApp, file: ParsedFileLink, local: boolean, sshHost?: string): string | undefined {
  const base = editorUrl(app, { path: file.path, local, sshHost });
  if (!base) return undefined;
  if (file.line === undefined) return base;
  return `${base}:${file.line}${file.column !== undefined ? `:${file.column}` : ""}`;
}

async function openExternalHttp(url: string, threadId?: string): Promise<void> {
  const state = useEnvironments.getState();
  const envId = threadId === undefined ? state.primaryId : (envOfThread(threadId) ?? state.primaryId);
  if (isLocalEnv(envId, state) && deviceLimitOf(envId) === undefined) {
    try {
      const result = await call("workspace.openExternal", { url }, envOpt(envId));
      if (result.ok) return;
    } catch {
      // fall through to browser window.open
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

async function openExternalFile(file: ParsedFileLink, threadId?: string): Promise<void> {
  const state = useEnvironments.getState();
  const envId = threadId === undefined ? state.primaryId : (envOfThread(threadId) ?? state.primaryId);
  const local = isLocalEnv(envId, state);
  const sshHost = envSshHost(envId, state);

  if (local && deviceLimitOf(envId) === undefined) {
    const apps: EditorApp[] = ["vscode", "cursor"];
    let lastError: string | undefined;
    for (const app of apps) {
      const url = editorFileUrl(app, file, true);
      if (!url) continue;
      try {
        const result = await call("workspace.openExternal", { url }, envOpt(envId));
        if (result.ok) return;
        lastError = result.error;
        if (lastError !== undefined && !/not installed|no handler|not found|-10814/i.test(lastError)) break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    try {
      await navigator.clipboard?.writeText(file.path);
      showToast(`Path copied (no external editor handled it): ${file.path}`);
    } catch {
      showToast(lastError ?? `Could not open ${file.path}`);
    }
    return;
  }

  const url = editorFileUrl("vscode", file, local, sshHost);
  if (url) {
    await launchEditorUrl(url, threadId ? { threadId } : {});
    return;
  }
  try {
    await navigator.clipboard?.writeText(file.path);
    showToast(`Copied path: ${file.path}`);
  } catch {
    showToast(`File is outside the workspace: ${file.path}`);
  }
}

/** Handles clicks on any markdown link without ever reloading or navigating the Tide view. */
export async function openMarkdownHref(href: string | undefined, threadId?: string): Promise<void> {
  if (!href) return;
  const trimmed = href.trim();
  if (trimmed === "") return;

  if (trimmed.startsWith("#")) {
    const target = document.getElementById(trimmed.slice(1));
    target?.scrollIntoView?.({ behavior: "smooth" });
    return;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    await openExternalHttp(trimmed, threadId);
    return;
  }

  if (/^(?:vscode|cursor):\/\//i.test(trimmed)) {
    await launchEditorUrl(trimmed, threadId ? { threadId } : {});
    return;
  }

  if (/^mailto:/i.test(trimmed)) {
    window.open(trimmed, "_blank", "noopener,noreferrer");
    return;
  }

  const file = parseFileLink(trimmed);
  if (!file) return;

  const ui = useUi.getState();
  const activeThreadId = threadId ?? ui.selectedThreadId ?? undefined;
  const model = useModel.getState().model;
  const thread = activeThreadId ? model.threads[activeThreadId] : undefined;
  const project = thread ? model.projects[thread.projectId] : undefined;

  let repoRel: string | undefined;
  if (!file.absolute) {
    repoRel = file.path;
  } else if (thread) {
    repoRel = relativeToRoot(file.path, thread.worktreePath) ?? relativeToRoot(file.path, project?.rootPath);
  }

  if (activeThreadId && repoRel !== undefined) {
    openFileTab(activeThreadId, repoRel, {
      ...(file.line !== undefined ? { line: file.line } : {}),
      ...(file.column !== undefined ? { column: file.column } : {}),
    });
    if (ui.focusMode === "thread") ui.setFocusMode("split");
    return;
  }

  await openExternalFile(file, activeThreadId);
}

/** Safe markdown `<a>` renderer: opens in-repo files in the Workbench, external files/URLs cleanly without reloading Tide. */
export function MarkdownLink({
  href,
  children,
  title,
  node: _node,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  const isHttp = typeof href === "string" && /^https?:\/\//i.test(href.trim());
  const resolvedHref = href && href.trim() !== "" ? href : undefined;
  return (
    <a
      {...rest}
      href={resolvedHref ?? "#"}
      title={title ?? resolvedHref}
      {...(isHttp ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      onClick={(event) => {
        event.preventDefault();
        if (resolvedHref) void openMarkdownHref(resolvedHref);
      }}
    >
      {children}
    </a>
  );
}
