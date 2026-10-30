/**
 * Visual replies (R11): fenced `html` blocks render in a sandboxed iframe, `mermaid`
 * blocks render to SVG. Both stay behind an opaque origin or mermaid's strict mode;
 * nothing the model writes runs with the app's origin.
 */

/** The only sandbox token: scripts run, but in an opaque origin (no `allow-same-origin`). */
export const HTML_SANDBOX = "allow-scripts";
export const HTML_PREVIEW_HEIGHT = 320;
export const HTML_PREVIEW_MIN = 120;
export const HTML_PREVIEW_MAX = 1200;

export function clampPreviewHeight(px: number): number {
  return Math.round(Math.min(HTML_PREVIEW_MAX, Math.max(HTML_PREVIEW_MIN, px)));
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A blob page for "Open in new tab". A blob URL carries the app's origin, so the
 * model's HTML never goes in it directly: it is nested in a sandboxed srcdoc frame.
 */
export function newTabDocument(html: string): string {
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>HTML preview</title>",
    "<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style>",
    `</head><body><iframe sandbox="${HTML_SANDBOX}" srcdoc="${escapeAttr(html)}"></iframe></body></html>`,
  ].join("");
}

export function openHtmlInNewTab(html: string): void {
  const url = URL.createObjectURL(new Blob([newTabDocument(html)], { type: "text/html" }));
  window.open(url, "_blank", "noopener");
  // the new tab has loaded it (or never will) well before this
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** `language-html` → `html`; undefined for a fence without a language. */
export function fenceLanguage(className: string | undefined): string | undefined {
  const match = /(?:^|\s)language-([\w-]+)/.exec(className ?? "");
  return match?.[1]?.toLowerCase();
}

/** The theme mermaid should draw in: Settings' `data-theme` wins, else the OS preference. */
export function mermaidTheme(): "dark" | "default" {
  const stamped = typeof document === "undefined" ? undefined : document.documentElement.dataset.theme;
  if (stamped === "light") return "default";
  if (stamped === "dark") return "dark";
  const prefersLight =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
      : false;
  return prefersLight ? "default" : "dark";
}

let counter = 0;

/** Renders a diagram to an SVG string; throws on a syntax error. mermaid loads on first use. */
export async function renderMermaid(code: string): Promise<string> {
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: mermaidTheme() });
  counter += 1;
  const id = `tide-mermaid-${counter}`;
  try {
    const { svg } = await mermaid.render(id, code);
    return svg;
  } finally {
    // a failed render leaves its scratch node (and error SVG) in <body>
    document.getElementById(`d${id}`)?.remove();
  }
}
