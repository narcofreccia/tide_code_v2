// Pixel evidence for scripts/desktop-ui-smoke.mjs when CDP is unavailable: a zero-dependency PNG
// decoder (8-bit RGB/RGBA, non-interlaced: what System.Drawing saves) and a "is this region a
// near-uniform colour?" analysis of the app window's client area in a desktop screenshot.
import fs from "node:fs";
import zlib from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const QUANT_SHIFT = 3; // 32 levels per channel: antialiasing noise falls into one bucket
const TOLERANCE = 8; // max per-channel distance from the dominant colour that still counts as "same"
const STEP = 2; // sample every 2nd pixel in both directions
/** Fraction of sampled pixels differing from the dominant colour above which the area has content. */
export const MIN_DIFFERENT_FRACTION = 0.02;
/** Distinct quantised colours above which the area has content. */
export const MIN_DISTINCT_COLOURS = 8;
// Fallback insets when only the outer window rect is known: invisible resize borders on the sides
// and bottom, title bar plus menu bar on top (both drawn light, so they must not count as content).
const FALLBACK_INSET = { left: 10, right: 10, top: 64, bottom: 10 };
const TASKBAR_ALLOWANCE = 48; // screen bottom reserved for the taskbar when the work area is unknown

/** Decodes a PNG buffer into { width, height, channels, data } (data = unfiltered RGB(A) bytes). */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let pos = 8;
  let ihdr = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === "IHDR") {
      ihdr = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colour: body[9], interlace: body[12] };
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
  }
  if (!ihdr) throw new Error("PNG without IHDR");
  const { width, height, depth, colour, interlace } = ihdr;
  const channels = colour === 2 ? 3 : colour === 6 ? 4 : 0;
  if (depth !== 8 || !channels || interlace !== 0) {
    throw new Error(`unsupported PNG (bit depth ${depth}, colour type ${colour}, interlace ${interlace})`);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const out = y * stride;
    const prev = y > 0 ? out - stride : -1;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? data[out + x - channels] : 0;
      const b = prev >= 0 ? data[prev + x] : 0;
      const c = prev >= 0 && x >= channels ? data[prev + x - channels] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      else if (filter !== 0) throw new Error(`bad PNG filter ${filter} on row ${y}`);
      data[out + x] = v & 0xff;
    }
  }
  return { width, height, channels, data };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** "x,y WxH" (what the window query prints) -> { left, top, right, bottom }. */
export function parseRect(text) {
  const m = /^(-?\d+),(-?\d+) (\d+)x(\d+)$/.exec(String(text ?? "").trim());
  if (!m) return null;
  const [left, top, w, h] = m.slice(1).map(Number);
  return { left, top, right: left + w, bottom: top + h };
}

/** A { left, top, right, bottom } object with a positive area, else null. */
export const validRect = (r) =>
  r && [r.left, r.top, r.right, r.bottom].every(Number.isFinite) && r.right > r.left && r.bottom > r.top ? r : null;

const rectText = (r) => `${r.left},${r.top} ${r.right - r.left}x${r.bottom - r.top}`;

function intersect(a, b) {
  const r = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  return r.right > r.left && r.bottom > r.top ? r : null;
}

/**
 * The screen region to analyse for one window: its client rect when the query returned one, else
 * the outer rect shrunk by conservative insets; either way clipped to the work area (or the screen
 * minus a taskbar allowance) so the taskbar never counts as app content.
 */
export function contentRegion(win, screen, workArea) {
  const screenRect = { left: 0, top: 0, right: screen.width, bottom: screen.height };
  const visible = validRect(workArea) ?? { ...screenRect, bottom: screen.height - TASKBAR_ALLOWANCE };
  let source = "client";
  let rect = validRect(win.client);
  if (!rect) {
    const outer = validRect(win.outer) ?? parseRect(win.rect);
    if (!outer) return { error: "no window rect" };
    source = "outer-fallback";
    rect = {
      left: outer.left + FALLBACK_INSET.left, top: outer.top + FALLBACK_INSET.top,
      right: outer.right - FALLBACK_INSET.right, bottom: outer.bottom - FALLBACK_INSET.bottom,
    };
  }
  const clipped = intersect(intersect(rect, screenRect) ?? rect, visible);
  if (!clipped) return { error: `window region ${rectText(rect)} is off screen`, source };
  return { source, rect: clipped, text: rectText(clipped) };
}

/** Dominant quantised colour of a region and how much of it differs from that colour. */
export function analyseRegion(img, rect) {
  const counts = new Map();
  const sums = new Map();
  let sampled = 0;
  for (let y = rect.top; y < rect.bottom; y += STEP) {
    for (let x = rect.left; x < rect.right; x += STEP) {
      const i = (y * img.width + x) * img.channels;
      const key = ((img.data[i] >> QUANT_SHIFT) << 10) | ((img.data[i + 1] >> QUANT_SHIFT) << 5) | (img.data[i + 2] >> QUANT_SHIFT);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const s = sums.get(key) ?? [0, 0, 0];
      s[0] += img.data[i]; s[1] += img.data[i + 1]; s[2] += img.data[i + 2];
      sums.set(key, s);
      sampled++;
    }
  }
  if (sampled === 0) return { error: "empty region" };
  let top = -1;
  for (const [k, n] of counts) if (top < 0 || n > counts.get(top)) top = k;
  const dominant = sums.get(top).map((v) => Math.round(v / counts.get(top)));
  let different = 0;
  for (let y = rect.top; y < rect.bottom; y += STEP) {
    for (let x = rect.left; x < rect.right; x += STEP) {
      const i = (y * img.width + x) * img.channels;
      const d = Math.max(Math.abs(img.data[i] - dominant[0]), Math.abs(img.data[i + 1] - dominant[1]), Math.abs(img.data[i + 2] - dominant[2]));
      if (d > TOLERANCE) different++;
    }
  }
  const hex = `#${dominant.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  return { sampled, dominant: hex, dominantShare: round(counts.get(top) / sampled), differentFraction: round(different / sampled), distinctColours: counts.size };
}

const round = (v) => Math.round(v * 10000) / 10000;

/**
 * Pixel evidence for one desktop capture: picks the app window (visible, not minimized), crops the
 * screenshot to its content region and analyses it. Never throws.
 */
export function pixelEvidence(file, windows, workArea) {
  try {
    const win = (windows ?? []).find((w) => w.visible && !w.minimized && (validRect(w.client) || validRect(w.outer) || parseRect(w.rect)));
    if (!win) return { pass: false, error: "no visible app window with a rect" };
    const img = decodePng(fs.readFileSync(file));
    const region = contentRegion(win, { width: img.width, height: img.height }, workArea ?? null);
    if (region.error) return { pass: false, ...region };
    const stats = analyseRegion(img, region.rect);
    if (stats.error) return { pass: false, region: region.text, ...stats };
    const pass = stats.differentFraction >= MIN_DIFFERENT_FRACTION && stats.distinctColours >= MIN_DISTINCT_COLOURS;
    return {
      pass, region: region.text, regionSource: region.source, ...stats,
      thresholds: { minDifferentFraction: MIN_DIFFERENT_FRACTION, minDistinctColours: MIN_DISTINCT_COLOURS, tolerance: TOLERANCE },
    };
  } catch (e) {
    return { pass: false, error: `pixel analysis: ${e?.message ?? e}` };
  }
}

/** One-line rendering of pixel evidence for summary.txt. */
export function pixelLine(p) {
  if (!p) return "pixels: n/a";
  if (p.error) return `pixels: ERROR ${p.error}${p.region ? ` (region ${p.region})` : ""}`;
  return `pixels: ${p.pass ? "content" : "UNIFORM"} — ${(p.differentFraction * 100).toFixed(2)}% differ from ${p.dominant}` +
    ` (dominant share ${(p.dominantShare * 100).toFixed(1)}%), ${p.distinctColours} distinct colours, region ${p.region} (${p.regionSource})` +
    ` [pass needs >= ${(MIN_DIFFERENT_FRACTION * 100).toFixed(0)}% and >= ${MIN_DISTINCT_COLOURS} colours]`;
}
