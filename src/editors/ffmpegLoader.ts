import { FFmpeg } from '@ffmpeg/ffmpeg';

// Lazily create and load a single shared FFmpeg instance. The 31MB core wasm is
// over Cloudflare Pages' 25MB per-file limit, so we load the core directly from
// jsdelivr (permissive CORS). @ffmpeg/ffmpeg creates a MODULE worker, so it
// `import()`s the coreURL — we must point at the ESM build (dist/esm), not UMD,
// or the dynamic import yields no default export and load fails. script-src must
// allow the CDN (worker imports the core JS), connect-src too (wasm fetch).
const CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
let instance: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;

export function isFfmpegLoaded(): boolean {
  return instance !== null;
}

export async function getFfmpeg(onProgress?: (ratio: number) => void): Promise<FFmpeg> {
  if (instance) return instance;
  if (loading) return loading;
  loading = (async () => {
    const ff = new FFmpeg();
    if (onProgress) ff.on('progress', ({ progress }) => onProgress(Math.max(0, Math.min(1, progress))));
    await ff.load({
      coreURL: `${CORE_BASE}/ffmpeg-core.js`,
      wasmURL: `${CORE_BASE}/ffmpeg-core.wasm`,
    });
    instance = ff;
    return ff;
  })();
  return loading;
}
