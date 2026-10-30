/**
 * A minimal QR Code encoder (ISO/IEC 18004): byte mode, error correction level M, versions 1–10
 * (up to 213 bytes), enough for a pairing URL. Ported from Project Nayuki's reference algorithm.
 * The mask is chosen by the standard penalty score unless one is forced (tests compare against
 * a reference matrix that way).
 */

const MAX_VERSION = 10;
// index = version; level M only
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
/** format-info bits for level M */
const ECL_FORMAT_BITS = 0;

export type QrMatrix = boolean[][];

function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

const dataCodewords = (ver: number): number => Math.floor(rawDataModules(ver) / 8) - (ECC_PER_BLOCK[ver] as number) * (NUM_BLOCKS[ver] as number);

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j] as number, root);
      if (j + 1 < result.length) result[j] = (result[j] as number) ^ (result[j + 1] as number);
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => (result[i] = (result[i] as number) ^ gfMul(coef, factor)));
  }
  return result;
}

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

const bit = (x: number, i: number): boolean => ((x >>> i) & 1) !== 0;

class Grid {
  readonly size: number;
  readonly modules: boolean[][];
  readonly fn: boolean[][];
  constructor(size: number) {
    this.size = size;
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  setFn(x: number, y: number, dark: boolean): void {
    (this.modules[y] as boolean[])[x] = dark;
    (this.fn[y] as boolean[])[x] = true;
  }
  get(x: number, y: number): boolean {
    return (this.modules[y] as boolean[])[x] as boolean;
  }
}

function drawFormatBits(g: Grid, mask: number): void {
  const data = (ECL_FORMAT_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const n = g.size;
  for (let i = 0; i <= 5; i++) g.setFn(8, i, bit(bits, i));
  g.setFn(8, 7, bit(bits, 6));
  g.setFn(8, 8, bit(bits, 7));
  g.setFn(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) g.setFn(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i++) g.setFn(n - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) g.setFn(8, n - 15 + i, bit(bits, i));
  g.setFn(8, n - 8, true);
}

function drawFunctionPatterns(g: Grid, ver: number): void {
  const n = g.size;
  for (let i = 0; i < n; i++) {
    g.setFn(6, i, i % 2 === 0);
    g.setFn(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < n && y >= 0 && y < n) g.setFn(x, y, dist !== 2 && dist !== 4);
      }
    }
  }
  const pos = alignmentPositions(ver);
  const k = pos.length;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === k - 1) || (i === k - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) g.setFn((pos[i] as number) + dx, (pos[j] as number) + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  drawFormatBits(g, 0); // reserved; redrawn with the chosen mask
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = n - 11 + (i % 3);
      const b = Math.floor(i / 3);
      g.setFn(a, b, bit(bits, i));
      g.setFn(b, a, bit(bits, i));
    }
  }
}

function interleave(data: number[], ver: number): number[] {
  const numBlocks = NUM_BLOCKS[ver] as number;
  const eccLen = ECC_PER_BLOCK[ver] as number;
  const raw = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0);
    blocks.push([...dat, ...ecc]);
  }
  const out: number[] = [];
  for (let i = 0; i < (blocks[0] as number[]).length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) out.push(block[i] as number);
    });
  }
  return out;
}

function drawCodewords(g: Grid, data: number[]): void {
  const n = g.size;
  let i = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? n - 1 - vert : vert;
        if (!(g.fn[y] as boolean[])[x] && i < data.length * 8) {
          (g.modules[y] as boolean[])[x] = bit(data[i >>> 3] as number, 7 - (i & 7));
          i++;
        }
      }
    }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(g: Grid, mask: number): void {
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) {
      if (!(g.fn[y] as boolean[])[x] && maskBit(mask, x, y)) (g.modules[y] as boolean[])[x] = !g.get(x, y);
    }
  }
}

/** Standard penalty (N1 runs, N2 blocks, N3 finder-like, N4 balance); lower scans better. */
function penalty(g: Grid): number {
  const n = g.size;
  let score = 0;
  const line = (at: (i: number) => boolean): void => {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && at(i) === at(i - 1)) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    const seq = Array.from({ length: n }, (_, i) => at(i));
    for (let i = 0; i + 7 <= n; i++) {
      const core = seq[i] && !seq[i + 1] && seq[i + 2] && seq[i + 3] && seq[i + 4] && !seq[i + 5] && seq[i + 6];
      if (!core) continue;
      const lightBefore = Array.from({ length: 4 }, (_, k) => i - 1 - k).every((p) => p < 0 || !seq[p]);
      const lightAfter = Array.from({ length: 4 }, (_, k) => i + 7 + k).every((p) => p >= n || !seq[p]);
      if (lightBefore || lightAfter) score += 40;
    }
  };
  for (let y = 0; y < n; y++) line((x) => g.get(x, y));
  for (let x = 0; x < n; x++) line((y) => g.get(x, y));
  let dark = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (g.get(x, y)) dark++;
      if (x + 1 < n && y + 1 < n) {
        const c = g.get(x, y);
        if (c === g.get(x + 1, y) && c === g.get(x, y + 1) && c === g.get(x + 1, y + 1)) score += 3;
      }
    }
  }
  const total = n * n;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** Encodes `text` (UTF-8) into a QR matrix (`true` = dark). Throws past version 10. */
export function encodeQr(text: string, options: { mask?: number; minVersion?: number } = {}): QrMatrix {
  const bytes = [...Buffer.from(text, "utf8")];
  let ver = options.minVersion ?? 1;
  for (; ver <= MAX_VERSION; ver++) {
    const used = 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8;
    if (used <= dataCodewords(ver) * 8) break;
  }
  if (ver > MAX_VERSION) throw new Error(`QR payload too long (${bytes.length} bytes)`);
  const capacity = dataCodewords(ver) * 8;
  const bits: number[] = [];
  const append = (value: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(0b0100, 4);
  append(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) append(b, 8);
  append(0, Math.min(4, capacity - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));

  const g = new Grid(ver * 4 + 17);
  drawFunctionPatterns(g, ver);
  drawCodewords(g, interleave(data, ver));
  let mask = options.mask;
  if (mask === undefined) {
    let best = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(g, m);
      drawFormatBits(g, m);
      const p = penalty(g);
      if (p < best) {
        best = p;
        mask = m;
      }
      applyMask(g, m); // xor undoes it
    }
  }
  applyMask(g, mask as number);
  drawFormatBits(g, mask as number);
  return g.modules;
}

/**
 * Two modules per character cell with half blocks and a 2-module quiet zone. With `ansi` the code is
 * drawn black on an explicit white background (scans on dark and light terminals alike); without,
 * dark modules are printed as blocks, which reads as an inverted code on a dark terminal.
 */
export function renderQr(matrix: QrMatrix, options: { ansi?: boolean } = {}): string {
  const quiet = 2;
  const n = matrix.length + quiet * 2;
  const at = (x: number, y: number): boolean => {
    const row = matrix[y - quiet];
    return row !== undefined && x >= quiet && x - quiet < row.length ? (row[x - quiet] as boolean) : false;
  };
  const lines: string[] = [];
  for (let y = 0; y < n; y += 2) {
    let line = "";
    for (let x = 0; x < n; x++) {
      const top = at(x, y);
      const bottom = y + 1 < n ? at(x, y + 1) : false;
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(options.ansi ? `\x1b[30;47m${line}\x1b[0m` : line);
  }
  return lines.join("\n");
}
