import { isValidElement, useEffect, useRef, useState } from "react";
import {
  HTML_PREVIEW_HEIGHT,
  HTML_SANDBOX,
  clampPreviewHeight,
  fenceLanguage,
  openHtmlInNewTab,
  renderMermaid,
} from "../../lib/visual.ts";
import { Button } from "../ui/Button.tsx";
import styles from "./VisualBlocks.module.css";

/**
 * A fenced `html` block: sandboxed preview (scripts in an opaque origin), a fixed
 * height the reader drags, the source one click away.
 */
export function HtmlPreview({ code }: { code: string }) {
  const [height, setHeight] = useState(HTML_PREVIEW_HEIGHT);
  const [source, setSource] = useState(false);
  const drag = useRef<{ y: number; h: number } | undefined>(undefined);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    drag.current = { y: e.clientY, h: height };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const start = drag.current;
    if (start) setHeight(clampPreviewHeight(start.h + e.clientY - start.y));
  };
  const onPointerUp = (): void => {
    drag.current = undefined;
  };

  return (
    <figure className={styles.html} aria-label="HTML preview">
      <figcaption className={styles.header}>
        <span className={styles.title}>HTML preview</span>
        <Button variant="link" onClick={() => openHtmlInNewTab(code)}>
          Open in new tab
        </Button>
        <Button variant="link" aria-expanded={source} onClick={() => setSource(!source)}>
          {source ? "Hide source" : "Show source"}
        </Button>
      </figcaption>
      <iframe className={styles.frame} title="HTML preview" sandbox={HTML_SANDBOX} srcDoc={code} height={height} />
      <div
        className={styles.handle}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize preview"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => setHeight(HTML_PREVIEW_HEIGHT)}
      />
      {source ? (
        <pre className={styles.source}>
          <code>{code}</code>
        </pre>
      ) : null}
    </figure>
  );
}

/** A fenced `mermaid` block drawn as SVG; any error shows the code block instead. */
export function MermaidBlock({ code }: { code: string }) {
  const [state, setState] = useState<{ svg?: string; failed?: boolean }>({});
  useEffect(() => {
    let live = true;
    setState({});
    renderMermaid(code).then(
      (svg) => live && setState({ svg }),
      () => live && setState({ failed: true }),
    );
    return () => {
      live = false;
    };
  }, [code]);
  if (state.svg === undefined) {
    return (
      <pre data-mermaid={state.failed ? "error" : "pending"}>
        <code className="language-mermaid">{code}</code>
      </pre>
    );
  }
  // mermaid's strict mode sanitises the SVG (DOMPurify) and disables click handlers
  return <div className={styles.mermaid} role="img" aria-label="Diagram" dangerouslySetInnerHTML={{ __html: state.svg }} />;
}

function codeOf(children: React.ReactNode): { lang?: string; text: string } | undefined {
  const child = Array.isArray(children) ? children[0] : children;
  if (!isValidElement(child)) return undefined;
  const props = child.props as { className?: string; children?: React.ReactNode };
  const text = Array.isArray(props.children) ? props.children.join("") : props.children;
  if (typeof text !== "string") return undefined;
  const lang = fenceLanguage(props.className);
  return lang === undefined ? { text } : { lang, text };
}

/** react-markdown `pre` override: html and mermaid fences become visuals, the rest stays code. */
export function MarkdownPre({ children, node: _node, ...rest }: React.ComponentProps<"pre"> & { node?: unknown }) {
  const code = codeOf(children);
  if (code?.lang === "html") return <HtmlPreview code={code.text.replace(/\n$/, "")} />;
  if (code?.lang === "mermaid") return <MermaidBlock code={code.text.replace(/\n$/, "")} />;
  return <pre {...rest}>{children}</pre>;
}
