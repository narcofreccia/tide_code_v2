/*
 * Incremental scanning of a reply that grows by appends (R15). A streaming delta must
 * not cost O(reply): the scan state remembers how far it got, and each call only walks
 * the lines that completed since. Used for the fence parity of the word-tail fade and
 * for splitting the reply into settled markdown blocks that are parsed once.
 */

const FENCE_LINE = /^ {0,3}(?:```|~~~)/;
const FENCE = /^ {0,3}(?:```|~~~)/gm;
/** a link reference or footnote definition can change blocks above it: no splitting then */
const REF_DEF = /^ {0,3}\[[^\]]+\]:/;
/** a line after a blank that still belongs to the block above (indented, or the next list item) */
const CONTINUES = /^(?:[ \t]|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;

export interface StreamScan {
  /** the text up to `pos`, to tell an append from a rewrite */
  head: string;
  /** offset just past the last complete line scanned */
  pos: number;
  /** fence lines among the complete lines */
  fences: number;
  /** the previous complete line was blank (outside a fence) */
  blank: boolean;
  /** a reference definition was seen: the reply is parsed as one block */
  noSplit: boolean;
  /** start offset of every block; `starts[0]` is 0 */
  starts: number[];
  /** the text of every block but the last (settled: nothing appended can change it) */
  settled: string[];
}

export function emptyScan(): StreamScan {
  return { head: "", pos: 0, fences: 0, blank: false, noSplit: false, starts: [0], settled: [] };
}

/**
 * Advances `scan` over the complete lines `text` added since the last call (mutates and
 * returns it), or starts over when `text` is not an append of what was scanned.
 * Idempotent for the same text, so a repeated render is harmless.
 */
export function advanceScan(scan: StreamScan, text: string): StreamScan {
  if (text.length < scan.pos || !text.startsWith(scan.head)) scan = emptyScan();
  let pos = scan.pos;
  let nl = text.indexOf("\n", pos);
  if (nl === -1) return scan;
  while (nl !== -1) {
    const line = text.slice(pos, nl);
    const inFence = scan.fences % 2 === 1;
    const empty = line.trim() === "";
    if (!inFence) {
      if (REF_DEF.test(line)) scan.noSplit = true;
      if (scan.blank && !empty && !CONTINUES.test(line)) {
        const last = scan.starts[scan.starts.length - 1] ?? 0;
        scan.settled.push(text.slice(last, pos));
        scan.starts.push(pos);
      }
    }
    scan.blank = !inFence && empty;
    if (FENCE_LINE.test(line)) scan.fences += 1;
    pos = nl + 1;
    nl = text.indexOf("\n", pos);
  }
  scan.pos = pos;
  scan.head = text.slice(0, pos);
  return scan;
}

/** a first character that cannot start a continuation, a list item or a definition */
const DECISIVE = /^[^ \t\-*+0-9[\n]/;

/**
 * Where the partial last line starts, when it already opens a new block: replies often
 * write a paragraph as one long line, and the block above should settle as soon as the
 * new one visibly starts rather than when its line ends. `undefined` otherwise.
 */
export function pendingStart(scan: StreamScan, text: string): number | undefined {
  if (scan.noSplit || !scan.blank || scan.fences % 2 === 1 || text.length <= scan.pos) return undefined;
  return DECISIVE.test(text.slice(scan.pos, scan.pos + 1)) ? scan.pos : undefined;
}

/** Whether `text` (already scanned up to its last newline) ends inside an open fence. */
export function endsInOpenFence(scan: StreamScan, text: string): boolean {
  const lastLine = text.slice(scan.pos);
  return (scan.fences + (FENCE_LINE.test(lastLine) ? 1 : 0)) % 2 === 1;
}

/** how many trailing words of a streaming reply fade in one by one */
export const TAIL_WORDS = 12;
/** a line this short rides its paragraph's block fade instead */
const MIN_LINE_WORDS = 4;
/** in the tail, anything markdown could read as syntax: the split is skipped */
const INLINE_SYNTAX = /[`*_~[\]<>&\\|@]|:\/\/|www\./;
/** a line that opens, continues or underlines something other than a plain paragraph */
const BLOCK_LINE = /^(?:[ \t]|[#>*+=<:|-]|\d+[.)]|```|~~~)/;

/**
 * While a reply streams, its last few words are held out of the markdown and
 * rendered as plain spans so each new word can fade in. Only when that cannot
 * change the result: the reply ends in a plain paragraph line (no open fence,
 * list, quote, heading or table in the last block) and the tail holds no
 * markdown syntax. Otherwise `undefined`, and the whole text goes to markdown.
 * `fenceOdd` comes from an incremental scan; without it the fences are counted here.
 * Apart from that it reads only the last paragraph.
 */
export function splitStreamingTail(
  text: string,
  words = TAIL_WORDS,
  fenceOdd?: boolean,
): { prefix: string; tail: string } | undefined {
  if (fenceOdd ?? (text.match(FENCE)?.length ?? 0) % 2 === 1) return undefined;
  // the reply's last block must be one plain paragraph (a `|` anywhere may make it a table)
  for (let end = text.length; ; ) {
    const start = text.lastIndexOf("\n", end - 1) + 1;
    const line = start > end ? "" : text.slice(start, end);
    if (line.trim() === "") break;
    if (BLOCK_LINE.test(line) || line.includes("|")) return undefined;
    if (start === 0) break;
    end = start - 1;
  }
  const lineStart = text.lastIndexOf("\n") + 1;
  const gaps = [...text.slice(lineStart).matchAll(/[ \t]+/g)].map((m) => lineStart + (m.index ?? 0));
  // a gap at the very start of the line is indentation, not a word boundary
  const inner = gaps.filter((at) => at > lineStart);
  if (inner.length < MIN_LINE_WORDS - 1) return undefined;
  const at = inner[Math.max(0, inner.length - words)]!;
  const prefix = text.slice(0, at);
  const tail = text.slice(at);
  if (prefix.trim() === "" || INLINE_SYNTAX.test(tail)) return undefined;
  return { prefix, tail };
}
