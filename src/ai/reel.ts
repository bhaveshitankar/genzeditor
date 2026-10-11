// Reel maker: renders image scenes + captions + narration + music into a video.
// NOTE: encoding is REALTIME (canvas.captureStream + MediaRecorder), so a 30s reel takes ~30s.
// Keep the tab in the foreground while rendering (rAF is throttled in background tabs).

export type ReelAspect = '9:16' | '1:1' | '16:9';
export interface ReelScene { image: string; text: string; seconds: number; motion: 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right'; }
export interface ReelOptions {
  aspect: ReelAspect; captions: boolean; title?: string;
  voice?: (AudioBuffer | null)[];
  music?: AudioBuffer | null; musicGain?: number;
  fps?: number;
  onProgress?: (fraction: number, label: string) => void;
  signal?: AbortSignal;
}

const OVERLAP = 0.5;
const BRAND = '#ff4d8d';

export function planTimeline(scenes: ReelScene[], voice?: (AudioBuffer | null)[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let prevEnd = 0;
  scenes.forEach((s, i) => {
    const v = voice?.[i];
    const len = Math.max(s.seconds || 0, v ? v.duration + 0.5 : 0);
    const start = i === 0 ? 0 : Math.max(0, prevEnd - OVERLAP);
    const end = start + len;
    out.push({ start, end });
    prevEnd = end;
  });
  return out;
}

export function wrapCaption(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const words = (text || '').split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  let i = 0;
  for (; i < words.length; i++) {
    const w = words[i];
    const next = cur ? cur + ' ' + w : w;
    if (!cur || measure(next) <= maxWidth) { cur = next; continue; }
    lines.push(cur);
    cur = w;
    if (lines.length === 3) break;
  }
  if (lines.length < 3) {
    if (cur) lines.push(cur);
    return lines;
  }
  // more than 3 lines: truncate third line with ellipsis
  let last = lines[2];
  while (last.length > 1 && measure(last + '…') > maxWidth) last = last.slice(0, -1).trimEnd();
  lines[2] = last + '…';
  return lines;
}

export async function decodeDataUrlAudio(dataUrl: string): Promise<AudioBuffer> {
  // Decode the base64 payload by hand: fetch('data:…') is blocked by the app's CSP (connect-src).
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const buf = bytes.buffer;
  const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
  const ctx = new AC();
  try {
    return await new Promise<AudioBuffer>((res, rej) => {
      const p = ctx.decodeAudioData(buf, res, rej) as Promise<AudioBuffer> | undefined;
      if (p && typeof p.then === 'function') p.then(res, rej);
    });
  } finally { try { void ctx.close(); } catch { /* ignore */ } }
}

const SIZES: Record<ReelAspect, [number, number]> = { '9:16': [720, 1280], '1:1': [720, 720], '16:9': [1280, 720] };

function abortErr(): DOMException { return new DOMException('Reel render aborted', 'AbortError'); }

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('reel_image_load_failed'));
    img.src = src;
  });
}

async function mixAudio(
  total: number, tl: { start: number; end: number }[], opts: ReelOptions,
): Promise<AudioBuffer | null> {
  const voice = opts.voice || [];
  const hasVoice = voice.some(Boolean);
  if (!hasVoice && !opts.music) return null;
  const rate = 44100;
  const OAC: typeof OfflineAudioContext = (window as any).OfflineAudioContext || (window as any).webkitOfflineAudioContext;
  const ctx = new OAC(2, Math.max(1, Math.ceil(total * rate)), rate);
  const musicGain = opts.musicGain ?? 0.35;
  if (opts.music) {
    const src = ctx.createBufferSource();
    src.buffer = opts.music;
    src.loop = true;
    const g = ctx.createGain();
    const g0 = musicGain;
    const duck = Math.min(0.18, g0);
    g.gain.setValueAtTime(g0, 0);
    voice.forEach((v, i) => {
      if (!v || !tl[i]) return;
      const a = tl[i].start, b = a + v.duration;
      g.gain.setValueAtTime(g0, Math.max(0, a - 0.15));
      g.gain.linearRampToValueAtTime(duck, a + 0.1);
      g.gain.setValueAtTime(duck, Math.max(a + 0.1, b - 0.05));
      g.gain.linearRampToValueAtTime(g0, b + 0.3);
    });
    const fadeStart = Math.max(0, total - 1.5);
    g.gain.setValueAtTime(g0, fadeStart);
    g.gain.linearRampToValueAtTime(0, total);
    src.connect(g); g.connect(ctx.destination);
    src.start(0);
    src.stop(total);
  }
  voice.forEach((v, i) => {
    if (!v || !tl[i]) return;
    const s = ctx.createBufferSource();
    s.buffer = v;
    s.connect(ctx.destination);
    s.start(tl[i].start);
  });
  return await new Promise<AudioBuffer>((res, rej) => {
    const p = ctx.startRendering() as Promise<AudioBuffer> | undefined;
    (ctx as any).oncomplete = (e: any) => res(e.renderedBuffer);
    if (p && typeof p.then === 'function') p.then(res, rej);
  });
}

function pickMime(): string {
  const MR = (window as any).MediaRecorder;
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const list = isSafari
    ? ['video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a', 'video/mp4'];
  for (const m of list) { try { if (MR.isTypeSupported(m)) return m; } catch { /* ignore */ } }
  return '';
}

export async function renderReel(
  scenes: ReelScene[], opts: ReelOptions,
): Promise<{ blob: Blob; mime: string; seconds: number; ext: 'webm' | 'mp4' }> {
  const MR = (window as any).MediaRecorder;
  const probe = document.createElement('canvas');
  if (!MR || typeof (probe as any).captureStream !== 'function') throw new Error('recording_unsupported');
  if (!scenes.length) throw new Error('reel_no_scenes');
  const { signal } = opts;
  const prog = (f: number, l: string) => { try { opts.onProgress?.(Math.max(0, Math.min(1, f)), l); } catch { /* ignore */ } };
  const check = () => { if (signal?.aborted) throw abortErr(); };
  check();

  const fps = opts.fps || 30;
  const [W, H] = SIZES[opts.aspect] || SIZES['9:16'];
  const tl = planTimeline(scenes, opts.voice);
  const total = tl[tl.length - 1].end;

  prog(0, 'Loading images');
  const imgs: HTMLImageElement[] = [];
  for (let i = 0; i < scenes.length; i++) {
    imgs.push(await loadImage(scenes[i].image));
    check();
    prog(0.1 * ((i + 1) / scenes.length), 'Loading images');
  }
  prog(0.1, 'Mixing audio');
  const mixed = await mixAudio(total, tl, opts);
  check();

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('recording_unsupported');

  const fontPx = Math.round(W * (W > H ? 0.032 : 0.05));
  const font = `800 ${fontPx}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

  const drawScene = (i: number, t: number, alpha: number) => {
    const img = imgs[i];
    const len = tl[i].end - tl[i].start;
    const p = Math.max(0, Math.min(1, (t - tl[i].start) / len));
    const m = scenes[i].motion;
    let scale = 1.15, dx = 0;
    if (m === 'zoom-in') scale = 1 + 0.15 * p;
    else if (m === 'zoom-out') scale = 1.15 - 0.15 * p;
    else { scale = 1.14; dx = (m === 'pan-left' ? -1 : 1) * (p - 0.5) * 0.12 * W; }
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const cover = Math.max(W / iw, H / ih) * scale;
    const dw = iw * cover, dh = ih * cover;
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, (W - dw) / 2 + dx, (H - dh) / 2, dw, dh);
    ctx.globalAlpha = 1;
  };

  const rr = (x: number, y: number, w: number, h: number, r: number) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };

  const drawCaption = (i: number, t: number) => {
    const text = scenes[i].text;
    if (!text) return;
    ctx.font = font;
    const maxW = W * 0.84;
    const lines = wrapCaption(text, maxW, s => ctx.measureText(s).width);
    if (!lines.length) return;
    const voiceLen = opts.voice?.[i]?.duration;
    const dur = Math.max(0.5, voiceLen ?? (tl[i].end - tl[i].start - OVERLAP));
    const prog01 = Math.max(0, Math.min(0.9999, (t - tl[i].start) / dur));
    const totalWords = lines.reduce((n, l) => n + l.split(' ').length, 0);
    const cur = Math.floor(prog01 * totalWords);
    const lh = fontPx * 1.3, padX = fontPx * 0.8, padY = fontPx * 0.55;
    let boxW = 0;
    for (const l of lines) boxW = Math.max(boxW, ctx.measureText(l).width);
    const boxH = lines.length * lh + padY * 2;
    const boxX = (W - boxW) / 2 - padX, boxY = H - H * 0.12 - boxH;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    rr(boxX, boxY, boxW + padX * 2, boxH, fontPx * 0.7); ctx.fill();
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    let wi = 0;
    lines.forEach((l, li) => {
      const lw = ctx.measureText(l).width;
      let x = (W - lw) / 2;
      const y = boxY + padY + lh * li + lh / 2;
      const sp = ctx.measureText(' ').width;
      for (const w of l.split(' ')) {
        ctx.fillStyle = wi === cur ? BRAND : '#fff';
        ctx.fillText(w, x, y);
        x += ctx.measureText(w).width + sp;
        wi++;
      }
    });
  };

  const drawTitle = (t: number) => {
    if (!opts.title || t > 2.6) return;
    const a = t < 0.5 ? t / 0.5 : t > 2 ? Math.max(0, (2.6 - t) / 0.6) : 1;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = `900 ${Math.round(fontPx * 1.5)}px system-ui, -apple-system, sans-serif`;
    const lines = wrapCaption(opts.title, W * 0.84, s => ctx.measureText(s).width);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = fontPx * 0.5;
    ctx.fillStyle = '#fff';
    const lh = fontPx * 1.9;
    lines.forEach((l, k) => ctx.fillText(l, W / 2, H * 0.3 + (k - (lines.length - 1) / 2) * lh));
    ctx.restore();
  };

  const drawFrame = (t: number) => {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    let active = 0;
    for (let i = 0; i < scenes.length; i++) if (t >= tl[i].start) active = i;
    if (active > 0) drawScene(active - 1, t, 1);
    const fade = active > 0 ? Math.min(1, (t - tl[active].start) / OVERLAP) : 1;
    // previous scene only needed while fading
    if (active > 0 && fade >= 1) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
    drawScene(active, t, fade);
    if (opts.captions) drawCaption(active, t);
    drawTitle(t);
  };

  drawFrame(0);
  const stream: MediaStream = (canvas as any).captureStream(fps);
  let actx: AudioContext | null = null;
  let src: AudioBufferSourceNode | null = null;
  if (mixed) {
    const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    actx = new AC();
    try { await actx.resume(); } catch { /* ignore */ }
    const dest = actx.createMediaStreamDestination();
    src = actx.createBufferSource();
    src.buffer = mixed;
    src.connect(dest);
    dest.stream.getAudioTracks().forEach(tr => stream.addTrack(tr));
  }

  const mime = pickMime();
  let rec: MediaRecorder;
  try {
    rec = mime ? new MR(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 }) : new MR(stream);
  } catch { stream.getTracks().forEach(t => t.stop()); void actx?.close(); throw new Error('recording_unsupported'); }
  const chunks: Blob[] = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise<void>(res => { rec.onstop = () => res(); });

  let raf = 0;
  const cleanup = () => {
    cancelAnimationFrame(raf);
    try { src?.stop(); } catch { /* ignore */ }
    stream.getTracks().forEach(t => t.stop());
    void actx?.close().catch(() => {});
    canvas.width = canvas.height = 0;
    imgs.length = 0;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => { try { if (rec.state !== 'inactive') rec.stop(); } catch { /* ignore */ } reject(abortErr()); };
      signal?.addEventListener('abort', onAbort, { once: true });
      rec.start(250);
      src?.start();
      const t0 = performance.now();
      const tick = () => {
        if (signal?.aborted) return;
        const t = (performance.now() - t0) / 1000;
        if (t >= total) { drawFrame(total - 0.001); prog(1, 'Finalizing'); resolve(); return; }
        drawFrame(t);
        prog(0.15 + 0.83 * (t / total), 'Rendering video');
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    });
    await new Promise(r => setTimeout(r, 150)); // let last frame flush
    if (rec.state !== 'inactive') rec.stop();
    await stopped;
  } catch (e) {
    try { if (rec.state !== 'inactive') rec.stop(); } catch { /* ignore */ }
    cleanup();
    throw e;
  }
  cleanup();
  const outMime = (rec.mimeType || mime || 'video/webm').split(';')[0] || 'video/webm';
  const blob = new Blob(chunks, { type: rec.mimeType || mime || 'video/webm' });
  return { blob, mime: blob.type || outMime, seconds: total, ext: outMime.includes('mp4') ? 'mp4' : 'webm' };
}
