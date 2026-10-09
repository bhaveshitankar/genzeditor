import type { FFmpeg } from '@ffmpeg/ffmpeg';

export type Quality = 'high' | 'balanced' | 'small';
export type OutFps = 24 | 30 | 60;

// x264 / vp9 CRF per quality tier (lower = bigger, better).
export const CRF: Record<Fmt, Record<Quality, number>> = {
  mp4: { high: 20, balanced: 24, small: 29 },
  webm: { high: 28, balanced: 33, small: 38 },
};
type Fmt = 'mp4' | 'webm';

// Rough bits per pixel per frame for ultrafast x264 / realtime vp9 at each tier.
const BPP: Record<Fmt, Record<Quality, number>> = {
  mp4: { high: 0.11, balanced: 0.065, small: 0.04 },
  webm: { high: 0.07, balanced: 0.045, small: 0.03 },
};

export function estimateBytes(fmt: Fmt, q: Quality, W: number, H: number, fps: number, secs: number, audio: boolean): number {
  const video = (W * H * fps * BPP[fmt][q] * secs) / 8;
  const aud = audio ? (160_000 * secs) / 8 : 0;
  return Math.round(video + aud);
}

export function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 1e7 ? 1 : 0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

// ffmpeg.wasm holds the whole input + output in WASM memory (4 GB hard cap, far
// less on phones). Returns a human warning when a job is likely to run out.
export function memoryWarning(inputBytes: number, W: number, H: number, secs: number, fps: number): string | null {
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const out = estimateBytes('mp4', 'high', W, H, fps, secs, true);
  const budget = mobile ? 500e6 : 1.5e9;
  if (inputBytes + out * 2 > budget) return 'Large export: this may run out of memory on this device. Try 720p, 24 fps or the Small quality.';
  if (mobile && W * H > 1920 * 1080) return 'This frame size is heavy for a phone. 1080p or lower is safer.';
  return null;
}

const CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';

// terminate() kills the worker (the only way to abort exec); load() again
// brings the shared instance back so the next export works.
export async function abortAndReload(ff: FFmpeg): Promise<void> {
  try { ff.terminate(); } catch { /* already gone */ }
  try {
    await ff.load({ coreURL: `${CORE_BASE}/ffmpeg-core.js`, wasmURL: `${CORE_BASE}/ffmpeg-core.wasm` });
  } catch { /* next export will surface the error */ }
}
