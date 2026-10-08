// Pure image processing for the document scanner: edge detection, quad
// finding, perspective warp and paper filters. Works on plain RGBA buffers
// ({data,width,height}, i.e. ImageData-compatible) so it runs in tests too.

export interface Pt { x: number; y: number }
/** Corners in order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Pt, Pt, Pt, Pt];
export interface Img { data: Uint8ClampedArray; width: number; height: number }
export type ScanFilter = 'original' | 'magic' | 'gray' | 'bw' | 'lighten';

export const makeImg = (width: number, height: number): Img =>
  ({ data: new Uint8ClampedArray(width * height * 4), width, height });

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

// ---------------------------------------------------------------- geometry

export function quadArea(q: Pt[]): number {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i], n = q[(i + 1) % q.length];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** Sort 4 points clockwise (screen coords) starting at the top-left one. */
export function orderQuad(pts: Pt[]): Quad {
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  const s = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let start = 0;
  for (let i = 1; i < 4; i++) if (s[i].x + s[i].y < s[start].x + s[start].y) start = i;
  return [0, 1, 2, 3].map((i) => ({ ...s[(start + i) % 4] })) as Quad;
}

export function isConvex(q: Pt[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cr) < 1e-9) return false;
    const s = Math.sign(cr);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

export function isValidQuad(q: Quad, w: number, h: number, minFrac = 0.2): boolean {
  return isConvex(q) && quadArea(q) >= minFrac * w * h;
}

export function defaultQuad(w: number, h: number, inset = 0.03): Quad {
  const dx = w * inset, dy = h * inset;
  return [{ x: dx, y: dy }, { x: w - dx, y: dy }, { x: w - dx, y: h - dy }, { x: dx, y: h - dy }];
}

export const fullQuad = (w: number, h: number): Quad => defaultQuad(w, h, 0);

export const scaleQuad = (q: Quad, sx: number, sy = sx): Quad =>
  q.map((p) => ({ x: p.x * sx, y: p.y * sy })) as Quad;

/** Rotate a quad along with its image 90° clockwise (image was w×h). */
export const rotateQuadCW = (q: Quad, _w: number, h: number): Quad =>
  orderQuad(q.map((p) => ({ x: h - p.y, y: p.x })));

/** Monotone-chain convex hull. */
export function convexHull(points: Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo: Pt[] = [], up: Pt[] = [];
  for (const pt of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], pt) <= 0) lo.pop();
    lo.push(pt);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i];
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], pt) <= 0) up.pop();
    up.push(pt);
  }
  lo.pop(); up.pop();
  return lo.concat(up);
}

/** Pick 4 hull points that (locally) maximize the enclosed area. */
export function quadFromHull(hull: Pt[]): Quad | null {
  if (hull.length < 4) return null;
  // Seed with extremal points of x+y and x−y.
  const by = (f: (p: Pt) => number, max: boolean) =>
    hull.reduce((b, p) => ((max ? f(p) > f(b) : f(p) < f(b)) ? p : b));
  const q: Pt[] = [by((p) => p.x + p.y, false), by((p) => p.x - p.y, true), by((p) => p.x + p.y, true), by((p) => p.x - p.y, false)];
  // Coordinate ascent: move each corner to the hull point maximizing area.
  for (let iter = 0; iter < 6; iter++) {
    let changed = false;
    for (let i = 0; i < 4; i++) {
      let best = q[i], bestA = quadArea(q);
      for (const h of hull) {
        const t = q.slice(); t[i] = h;
        const a = isConvex(t) ? quadArea(t) : 0;
        if (a > bestA + 1e-6) { bestA = a; best = h; }
      }
      if (best !== q[i]) { q[i] = best; changed = true; }
    }
    if (!changed) break;
  }
  const o = orderQuad(q);
  return isConvex(o) ? o : null;
}

/** Output size for a warped quad: average opposite edges, long side capped. */
export function outputSize(q: Quad, maxLong = 2480): { w: number; h: number } {
  const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  let w = (d(q[0], q[1]) + d(q[3], q[2])) / 2;
  let h = (d(q[0], q[3]) + d(q[1], q[2])) / 2;
  const s = Math.min(1, maxLong / Math.max(w, h));
  w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s));
  return { w, h };
}

/** Homography H (row-major 3×3, h8 = 1) mapping src[i] → dst[i]. */
export function homography(src: Pt[], dst: Pt[]): number[] {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x: u, y: v } = src[i], { x, y } = dst[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  }
  // Gaussian elimination with partial pivoting on the 8×9 augmented matrix.
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    const d = A[c][c] || 1e-12;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / d;
      if (f) for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  const h = A.map((row, i) => row[8] / (row[i] || 1e-12));
  h.push(1);
  return h;
}

export function applyH(H: number[], x: number, y: number): Pt {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

/** Inverse-map rows [y0,y1) of dst from src via H (dst → src), bilinear. */
export function warpRows(src: Img, dst: Img, H: number[], y0: number, y1: number): void {
  const { data: s, width: sw, height: sh } = src;
  const { data: d, width: dw } = dst;
  const maxX = sw - 1, maxY = sh - 1;
  for (let y = y0; y < y1; y++) {
    const v = y + 0.5;
    let o = y * dw * 4;
    for (let x = 0; x < dw; x++, o += 4) {
      const u = x + 0.5;
      const iw = 1 / (H[6] * u + H[7] * v + H[8]);
      let sx = (H[0] * u + H[1] * v + H[2]) * iw - 0.5;
      let sy = (H[3] * u + H[4] * v + H[5]) * iw - 0.5;
      sx = sx < 0 ? 0 : sx > maxX ? maxX : sx;
      sy = sy < 0 ? 0 : sy > maxY ? maxY : sy;
      const x0 = sx | 0, y0i = sy | 0;
      const x1 = x0 < maxX ? x0 + 1 : x0, y1i = y0i < maxY ? y0i + 1 : y0i;
      const fx = sx - x0, fy = sy - y0i;
      const a = (y0i * sw + x0) * 4, b = (y0i * sw + x1) * 4, c = (y1i * sw + x0) * 4, e = (y1i * sw + x1) * 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      d[o] = s[a] * w00 + s[b] * w10 + s[c] * w01 + s[e] * w11;
      d[o + 1] = s[a + 1] * w00 + s[b + 1] * w10 + s[c + 1] * w01 + s[e + 1] * w11;
      d[o + 2] = s[a + 2] * w00 + s[b + 2] * w10 + s[c + 2] * w01 + s[e + 2] * w11;
      d[o + 3] = 255;
    }
  }
}

const defaultYield = () => new Promise<void>((r) => setTimeout(r, 0));

/** Perspective-correct `quad` of src into a rectangle; yields between chunks. */
export async function warpPerspective(
  src: Img, quad: Quad, maxLong = 2480, yieldFn: () => Promise<void> = defaultYield,
): Promise<Img> {
  const { w, h } = outputSize(quad, maxLong);
  const dst = makeImg(w, h);
  const H = homography([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], quad);
  const rowsPerChunk = Math.max(16, Math.floor(400_000 / w));
  for (let y = 0; y < h; y += rowsPerChunk) {
    warpRows(src, dst, H, y, Math.min(h, y + rowsPerChunk));
    if (y + rowsPerChunk < h) await yieldFn();
  }
  return dst;
}

// ---------------------------------------------------------- edge detection

export function toGray(img: Img): Float32Array {
  const { data, width, height } = img;
  const g = new Float32Array(width * height);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  return g;
}

/** Separable 5-tap Gaussian ([1 4 6 4 1]/16). */
export function gaussianBlur(src: Float32Array, w: number, h: number): Float32Array {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const k = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -2; i <= 2; i++) s += k[i + 2] * src[y * w + Math.min(w - 1, Math.max(0, x + i))];
    tmp[y * w + x] = s;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -2; i <= 2; i++) s += k[i + 2] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
    out[y * w + x] = s;
  }
  return out;
}

export function sobel(g: Float32Array, w: number, h: number): Float32Array {
  const m = new Float32Array(g.length);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1];
    const gy = g[i + w - 1] + 2 * g[i + w] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - w] - g[i - w + 1];
    m[i] = Math.sqrt(gx * gx + gy * gy);
  }
  return m;
}

/** Otsu threshold of values assumed in [0,255]. */
export function otsu(v: ArrayLike<number>): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < v.length; i++) hist[clamp255(v[i] | 0)]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = v.length - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; t = i; }
  }
  return t;
}

/** Edge mask from gradient magnitude: Otsu high threshold + hysteresis. */
export function edgeMask(mag: Float32Array, w: number, h: number): Uint8Array {
  let max = 0;
  for (let i = 0; i < mag.length; i++) if (mag[i] > max) max = mag[i];
  const out = new Uint8Array(mag.length);
  if (max <= 0) return out;
  const norm = new Float32Array(mag.length);
  for (let i = 0; i < mag.length; i++) norm[i] = (mag[i] / max) * 255;
  const hi = Math.max(20, otsu(norm)), lo = hi * 0.5;
  const stack: number[] = [];
  for (let i = 0; i < norm.length; i++) if (norm[i] >= hi) { out[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop()!, x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (!out[j] && norm[j] >= lo) { out[j] = 1; stack.push(j); }
    }
  }
  return out;
}

function dilate(m: Uint8Array, w: number, h: number): Uint8Array {
  const o = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!m[y * w + x]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h) o[ny * w + nx] = 1;
    }
  }
  return o;
}

interface Comp { label: number; area: number; border: number; bbox: number }

/** 8-connected component labelling of a binary mask. */
function components(m: Uint8Array, w: number, h: number): { labels: Int32Array; comps: Comp[] } {
  const labels = new Int32Array(m.length);
  const comps: Comp[] = [];
  const stack: number[] = [];
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || labels[s]) continue;
    const label = comps.length + 1;
    let area = 0, border = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
    labels[s] = label; stack.push(s);
    while (stack.length) {
      const i = stack.pop()!, x = i % w, y = (i / w) | 0;
      area++;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (m[j] && !labels[j]) { labels[j] = label; stack.push(j); }
      }
    }
    comps.push({ label, area, border, bbox: (x1 - x0 + 1) * (y1 - y0 + 1) });
  }
  return { labels, comps };
}

/** Hull of a component using per-row extreme pixels (cheap & exact for hulls). */
function compHull(labels: Int32Array, label: number, w: number, h: number): Pt[] {
  const pts: Pt[] = [];
  for (let y = 0; y < h; y++) {
    let a = -1, b = -1;
    for (let x = 0, i = y * w; x < w; x++, i++) if (labels[i] === label) { if (a < 0) a = x; b = x; }
    if (a >= 0) { pts.push({ x: a, y }); if (b !== a) pts.push({ x: b + 1, y }); }
  }
  return convexHull(pts);
}

/** Fraction of points along the quad sides that lie near an edge pixel. */
export function edgeSupport(q: Quad, edges: Uint8Array, w: number, h: number): number {
  let total = 0, worst = 1;
  for (let s = 0; s < 4; s++) {
    const a = q[s], b = q[(s + 1) % 4];
    let hits = 0; const n = 40;
    for (let k = 0; k < n; k++) {
      const t = 0.1 + (0.8 * k) / (n - 1);
      const cx = Math.round(a.x + (b.x - a.x) * t), cy = Math.round(a.y + (b.y - a.y) * t);
      let hit = false;
      for (let dy = -2; dy <= 2 && !hit; dy++) for (let dx = -2; dx <= 2 && !hit; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && y >= 0 && x < w && y < h && edges[y * w + x]) hit = true;
      }
      if (hit) hits++;
    }
    const f = hits / n;
    total += f; worst = Math.min(worst, f);
  }
  return 0.5 * (total / 4) + 0.5 * worst;
}

/**
 * Detect the document quad in a (small, ~400–500px) image. Returns the quad in
 * the image's coordinates plus whether it was found (else a default inset).
 */
export function detectQuad(img: Img): { quad: Quad; found: boolean; score: number } {
  const { width: w, height: h } = img;
  const fallback = { quad: defaultQuad(w, h), found: false, score: 0 };
  if (w < 16 || h < 16) return fallback;
  const blur = gaussianBlur(toGray(img), w, h);
  const edges = edgeMask(sobel(blur, w, h), w, h);
  const total = w * h;
  const candidates: Quad[] = [];
  const consider = (mask: Uint8Array, minFrac: number, maxBorder: number) => {
    const { labels, comps } = components(mask, w, h);
    comps
      .filter((c) => c.bbox >= minFrac * total && c.border <= maxBorder * 2 * (w + h))
      .sort((a, b) => b.bbox - a.bbox)
      .slice(0, 3)
      .forEach((c) => { const q = quadFromHull(compHull(labels, c.label, w, h)); if (q) candidates.push(q); });
  };
  // 1) Edge-based: closed document outline (gaps bridged by dilation).
  consider(dilate(edges, w, h), 0.2, 0.25);
  // 2) Brightness segmentation: bright paper on darker background (and inverse).
  const t = otsu(blur);
  const bright = new Uint8Array(total), dark = new Uint8Array(total);
  for (let i = 0; i < total; i++) { if (blur[i] > t) bright[i] = 1; else dark[i] = 1; }
  consider(bright, 0.2, 0.35);
  consider(dark, 0.2, 0.35);

  let best: Quad | null = null, bestScore = -1;
  for (const q of candidates) {
    if (!isValidQuad(q, w, h)) continue;
    const frac = quadArea(q) / total;
    let score = edgeSupport(q, edges, w, h) + 0.1 * frac;
    if (frac > 0.97) score -= 0.3; // basically the whole frame: weak evidence
    if (score > bestScore) { bestScore = score; best = q; }
  }
  if (!best || bestScore < 0.25) return fallback;
  return { quad: best, found: true, score: bestScore };
}

// ------------------------------------------------------------------ filters

export function applyFilter(src: Img, f: ScanFilter): Img {
  switch (f) {
    case 'magic': return magic(src);
    case 'gray': return grayscale(src);
    case 'bw': return blackWhite(src);
    case 'lighten': return lighten(src);
    default: return { data: new Uint8ClampedArray(src.data), width: src.width, height: src.height };
  }
}

export function grayscale(src: Img): Img {
  const out = makeImg(src.width, src.height), s = src.data, d = out.data;
  for (let i = 0; i < s.length; i += 4) {
    const v = 0.299 * s[i] + 0.587 * s[i + 1] + 0.114 * s[i + 2];
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  return out;
}

export function lighten(src: Img): Img {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = 255 * Math.pow(i / 255, 0.7) * 1.04 + 4;
  const out = makeImg(src.width, src.height), s = src.data, d = out.data;
  for (let i = 0; i < s.length; i += 4) { d[i] = lut[s[i]]; d[i + 1] = lut[s[i + 1]]; d[i + 2] = lut[s[i + 2]]; d[i + 3] = 255; }
  return out;
}

/**
 * Per-channel background (paper) estimate: block maxima on a coarse grid,
 * box-smoothed. Returned as a small grid to be bilinearly upsampled.
 */
function backgroundGrid(src: Img, c: number, bs: number) {
  const { data, width: w, height: h } = src;
  const gw = Math.ceil(w / bs), gh = Math.ceil(h / bs);
  let g = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    // 95th-ish percentile via max of sparse samples (ignores dark ink).
    let m = 0;
    const ye = Math.min(h, (gy + 1) * bs), xe = Math.min(w, (gx + 1) * bs);
    for (let y = gy * bs; y < ye; y += 2) for (let x = gx * bs; x < xe; x += 2) {
      const v = data[(y * w + x) * 4 + c]; if (v > m) m = v;
    }
    g[gy * gw + gx] = m;
  }
  for (let pass = 0; pass < 2; pass++) {
    const n = new Float32Array(g.length);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let s = 0, k = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < gw && ny < gh) { s += g[ny * gw + nx]; k++; }
      }
      n[y * gw + x] = s / k;
    }
    g = n;
  }
  return { g, gw, gh };
}

/** "Magic" enhance: illumination/white-balance flattening, contrast stretch, sharpen. */
export function magic(src: Img): Img {
  const { width: w, height: h, data: s } = src;
  const bs = Math.max(8, Math.ceil(Math.max(w, h) / 40));
  const out = makeImg(w, h), d = out.data;
  // Precompute horizontal interpolation lookups.
  const gx0 = new Int32Array(w), gx1 = new Int32Array(w), fxs = new Float32Array(w);
  for (let c = 0; c < 3; c++) {
    const { g, gw, gh } = backgroundGrid(src, c, bs);
    for (let x = 0; x < w; x++) {
      const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / bs - 0.5));
      gx0[x] = fx | 0; gx1[x] = Math.min(gw - 1, gx0[x] + 1); fxs[x] = fx - gx0[x];
    }
    for (let y = 0; y < h; y++) {
      const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / bs - 0.5));
      const r0 = (fy | 0) * gw, r1 = Math.min(gh - 1, (fy | 0) + 1) * gw, wy = fy - (fy | 0);
      for (let x = 0, i = y * w * 4 + c; x < w; x++, i += 4) {
        const a = g[r0 + gx0[x]] + (g[r0 + gx1[x]] - g[r0 + gx0[x]]) * fxs[x];
        const b = g[r1 + gx0[x]] + (g[r1 + gx1[x]] - g[r1 + gx0[x]]) * fxs[x];
        const bg = Math.max(40, a + (b - a) * wy);
        d[i] = (s[i] / bg) * 255;
      }
    }
  }
  // Contrast stretch on luminance percentiles; push near-white paper to white.
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) hist[(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0]++;
  let acc = 0, lo = 0;
  const n = w * h;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > n * 0.01) { lo = i; break; } }
  const hi = 235;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    const t = Math.min(1, Math.max(0, (i - lo) / Math.max(1, hi - lo)));
    lut[i] = 255 * Math.pow(t, 1.25);
  }
  for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; d[i + 3] = 255; }
  return sharpen(out, 0.6);
}

/** Unsharp mask with a 3×3 box blur. */
export function sharpen(src: Img, amount: number): Img {
  const { width: w, height: h, data: s } = src;
  const out = makeImg(w, h), d = out.data;
  d.set(s);
  const row = w * 4;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) {
      const j = i + c;
      const blur = (s[j - row - 4] + s[j - row] + s[j - row + 4] + s[j - 4] + s[j] + s[j + 4] + s[j + row - 4] + s[j + row] + s[j + row + 4]) / 9;
      d[j] = s[j] + amount * (s[j] - blur);
    }
  }
  return out;
}

/** Bradley adaptive threshold using an integral image. */
export function blackWhite(src: Img, t = 0.15): Img {
  const { width: w, height: h } = src;
  const g = toGray(src);
  const W = w + 1;
  const ii = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0;
    for (let x = 0; x < w; x++) { rs += g[y * w + x]; ii[(y + 1) * W + x + 1] = ii[y * W + x + 1] + rs; }
  }
  const r = Math.max(4, Math.round(Math.max(w, h) / 32));
  const out = makeImg(w, h), d = out.data;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const cnt = (x1 - x0) * (y1 - y0);
      const sum = ii[y1 * W + x1] - ii[y0 * W + x1] - ii[y1 * W + x0] + ii[y0 * W + x0];
      const v = g[y * w + x] * cnt <= sum * (1 - t) ? 0 : 255;
      const i = (y * w + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
  }
  return out;
}
