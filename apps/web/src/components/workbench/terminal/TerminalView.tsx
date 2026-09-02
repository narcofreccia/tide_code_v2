import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { stream, type StreamControl } from "../../../state/model.ts";
import { onReconnect } from "../../../state/reconnect.ts";
import { markExited, resizePty, writePty } from "../../../state/terminals.ts";
import { subscribeTheme } from "../monaco/themes.ts";
import styles from "./TerminalDrawer.module.css";

const RESIZE_DEBOUNCE_MS = 120;

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
}

/** xterm palette from the design tokens, so the drawer follows the shell theme. */
function themeFromTokens(): Record<string, string> {
  return {
    background: cssVar("--surface", "#16191f"),
    foreground: cssVar("--text", "#e6e9ef"),
    cursor: cssVar("--accent", "#5b9dff"),
    selectionBackground: cssVar("--accent-soft", "rgba(91,157,255,0.16)"),
  };
}

/** One attached pty: replayed scrollback, live output, keystrokes, fit-driven resize. */
export function TerminalView({ threadId, ptyId }: { threadId: string; ptyId: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return undefined;

    const term = new Terminal({
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      theme: themeFromTokens(),
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(element);
    try {
      fit.fit();
    } catch {
      /* zero-sized container (hidden drawer) */
    }

    const input = term.onData((data) => writePty(ptyId, data));

    const attach = (): StreamControl => {
      const handle = stream("pty.attach", { ptyId }, (chunk) => {
        if (chunk.kind === "data") term.write(chunk.data);
        else {
          term.write(`\r\n[exited code ${chunk.code ?? 0}]\r\n`);
          markExited(threadId, ptyId);
        }
      });
      handle.done.catch(() => undefined);
      return handle;
    };
    // the attach dies with the socket; on reconnect the pty is still alive on the
    // server, so re-attaching replays its scrollback into the same terminal
    let control = attach();
    const offReconnect = onReconnect(() => {
      control.cancel();
      control = attach();
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          fit.fit();
        } catch {
          return;
        }
        resizePty(ptyId, term.cols, term.rows);
      }, RESIZE_DEBOUNCE_MS);
    };
    // the palette comes from the tokens, so a theme change means re-reading them
    const unsubscribeTheme = subscribeTheme(() => {
      term.options.theme = themeFromTokens();
    });

    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(onResize);
    observer?.observe(element);
    window.addEventListener("resize", onResize);

    return () => {
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener("resize", onResize);
      unsubscribeTheme();
      observer?.disconnect();
      offReconnect();
      input.dispose();
      control.cancel();
      term.dispose();
    };
  }, [threadId, ptyId]);

  return <div className={styles.surface} data-testid="terminal-surface" ref={host} />;
}
