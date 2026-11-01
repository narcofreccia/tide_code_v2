import { Fragment, memo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MarkdownPre, OpenFence } from "./VisualBlocks.tsx";
import { advanceScan, emptyScan, endsInOpenFence, pendingStart, type StreamScan } from "./streamBlocks.ts";

const REMARK_PLUGINS = [remarkGfm];
const COMPONENTS = { pre: MarkdownPre };

/** One parse. Memoized on its text, so a settled block is parsed once and never again. */
const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
      {text}
    </ReactMarkdown>
  );
});

/**
 * Assistant markdown (GFM, html/mermaid fences as visuals). Settled, it is one parse.
 * Streaming, the reply is cut into blocks at blank lines outside fences; every block but
 * the last is settled and keeps its parse, so a delta re-parses only the open tail. A
 * visual whose fence is still open shows as plain code until the fence closes.
 */
export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const scanRef = useRef<StreamScan | undefined>(undefined);
  if (!streaming) {
    scanRef.current = undefined;
    return [block(0, text, undefined)];
  }
  const scan = (scanRef.current = advanceScan(scanRef.current ?? emptyScan(), text));
  const open = endsInOpenFence(scan, text);
  if (scan.noSplit) return [block(0, text, open ? text.length : undefined)];
  const blocks = scan.settled.map((settled, i) => block(scan.starts[i] ?? 0, settled, undefined));
  let lastStart = scan.starts[scan.starts.length - 1] ?? 0;
  const pending = pendingStart(scan, text);
  if (pending !== undefined) {
    blocks.push(block(lastStart, text.slice(lastStart, pending), undefined));
    lastStart = pending;
  }
  const tail = text.slice(lastStart);
  // one keyed shape for settled and open blocks: the block that settles keeps its instance
  blocks.push(block(lastStart, tail, open ? tail.length : undefined));
  return blocks;
});

/** A block keyed by its start offset; `"\n"` between blocks as one parse would put it. */
function block(start: number, text: string, openFenceEnd: number | undefined) {
  return (
    <Fragment key={start}>
      {start > 0 ? "\n" : null}
      <OpenFence.Provider value={openFenceEnd}>
        <MarkdownBlock text={text} />
      </OpenFence.Provider>
    </Fragment>
  );
}
