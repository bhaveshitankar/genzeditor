// Pure per-pixel adjustment math for the image editor (testable without a DOM).

export interface ToneParams {
  highlights: number; // -100..100
  shadows: number;    // -100..100
  vibrance: number;   // -100..100
  grain: number;      // 0..100
  fade: number;       // 0..100 (lifted blacks)
  blackPoint: number; // 0..100 (levels input black)
  whitePoint: number; // 0..100 (levels input white, 0 = untouched)
}

export const NEUTRAL_TONE: ToneParams = { highlights: 0, shadows: 0, vibrance: 0, grain: 0, fade: 0, blackPoint: 0, whitePoint: 0 };

export function needsTonePass(p: ToneParams): boolean {
  return p.highlights !== 0 || p.shadows !== 0 || p.vibrance !== 0 || p.grain > 0 || p.fade > 0 || p.blackPoint > 0 || p.whitePoint > 0;
}

const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

// Deterministic PRNG so grain is stable between preview renders and export.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Apply levels, fade, shadows/highlights, vibrance and grain in place. */
export function applyTone(data: Uint8ClampedArray, p: ToneParams): void {
  const bp = (p.blackPoint / 100) * 100;            // up to 100/255 input black
  const wp = 255 - (p.whitePoint / 100) * 100;      // down to 155 input white
  const range = Math.max(1, wp - bp);
  const lift = (p.fade / 100) * 50;
  const hi = p.highlights / 100, sh = p.shadows / 100, vib = p.vibrance / 100;
  const noise = (p.grain / 100) * 48;
  const rand = rng(1337);
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
    if (bp > 0 || p.whitePoint > 0) {
      r = clamp(((r - bp) / range) * 255); g = clamp(((g - bp) / range) * 255); b = clamp(((b - bp) / range) * 255);
    }
    if (lift > 0) {
      const k = 1 - lift / 255;
      r = lift + r * k; g = lift + g * k; b = lift + b * k;
    }
    if (hi !== 0 || sh !== 0) {
      const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      const d = (sh * (1 - l) * (1 - l) + hi * l * l) * 70;
      r = clamp(r + d); g = clamp(g + d); b = clamp(b + d);
    }
    if (vib !== 0) {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      const f = 1 + vib * (1 - sat);
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      r = clamp(l + (r - l) * f); g = clamp(l + (g - l) * f); b = clamp(l + (b - l) * f);
    }
    if (noise > 0) {
      const n = (rand() + rand() - 1) * noise;
      r = clamp(r + n); g = clamp(g + n); b = clamp(b + n);
    }
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
  }
}

export interface Histogram { luma: number[]; r: number[]; g: number[]; b: number[]; max: number }

export function computeHistogram(data: Uint8ClampedArray): Histogram {
  const luma = new Array<number>(256).fill(0), r = luma.slice(), g = luma.slice(), b = luma.slice();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! === 0) continue;
    const R = data[i]!, G = data[i + 1]!, B = data[i + 2]!;
    r[R]!++; g[G]!++; b[B]!++;
    luma[Math.round(0.299 * R + 0.587 * G + 0.114 * B)]!++;
  }
  // Ignore the extreme end bins when scaling so clipped pixels don't flatten the plot.
  let max = 1;
  for (let i = 1; i < 255; i++) max = Math.max(max, luma[i]!, r[i]!, g[i]!, b[i]!);
  return { luma, r, g, b, max };
}

export interface ExportOptions { format: 'image/png' | 'image/jpeg' | 'image/webp'; quality: number; maxDim: number }

/** Output size for an export: maxDim 0 = original; never upscales. */
export function exportSize(w: number, h: number, maxDim: number): { w: number; h: number } {
  if (maxDim <= 0) return { w, h };
  const s = Math.min(1, maxDim / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}
