// Song / narration assembly: turn per-section TTS audio + a musical plan into one
// synced track. "Voice first": the sung/spoken audio decides how many bars each
// section needs, so every lyric line is audible and lands on a downbeat; the
// backing track is then rendered to exactly that structure.
import { renderSong, SONG_LEAD_IN, type SongPlan } from './songSynth';

export interface Span { start: number; end: number }       // seconds inside a source buffer
export interface TimedLine { text: string; start: number; end: number; section: string }

// ---- pure helpers (unit-tested) ------------------------------------------------

/**
 * Split one TTS buffer that speaks `n` lines into `n` spans by cutting at the pauses
 * nearest to where each line should end (by character weight). Falls back to the
 * proportional position when no pause is found, so it always returns exactly `n`.
 */
export function splitBySilence(x: Float32Array, sr: number, n: number, weights?: number[]): Span[] {
  const hop = Math.max(1, Math.round(sr * 0.01));
  const frames = Math.floor(x.length / hop);
  const rms = new Float32Array(frames);
  let max = 0;
  for (let f = 0; f < frames; f++) {
    let s = 0; for (let j = f * hop, e = j + hop; j < e; j++) s += x[j]! * x[j]!;
    rms[f] = Math.sqrt(s / hop); if (rms[f]! > max) max = rms[f]!;
  }
  const thr = Math.max(1e-4, max * 0.06);
  let first = 0; while (first < frames && rms[first]! < thr) first++;
  let last = frames - 1; while (last > first && rms[last]! < thr) last--;
  const total = x.length / sr;
  if (frames === 0 || last <= first) return Array.from({ length: Math.max(1, n) }, (_, i) => ({ start: (total * i) / Math.max(1, n), end: (total * (i + 1)) / Math.max(1, n) }));
  const pad = 3; // keep 30 ms around speech
  const toSpan = (a: number, b: number): Span => ({ start: Math.max(0, (a - pad) * hop / sr), end: Math.min(total, (b + pad) * hop / sr) });
  if (n <= 1) return [toSpan(first, last)];

  // Silent runs (>= 90 ms) strictly inside the speech.
  const runs: { s: number; e: number; mid: number }[] = [];
  for (let f = first; f <= last;) {
    if (rms[f]! >= thr) { f++; continue; }
    let g = f; while (g <= last && rms[g]! < thr) g++;
    if (g - f >= 9) runs.push({ s: f, e: g, mid: (f + g) / 2 });
    f = g;
  }
  const w = weights && weights.length === n ? weights.map((v) => Math.max(1, v)) : Array.from({ length: n }, () => 1);
  const wsum = w.reduce((a, b) => a + b, 0);
  const span = last - first;
  const cuts: { s: number; e: number }[] = []; // each cut is a silent gap [s,e)
  let acc = 0, prevMid = first;
  for (let k = 1; k < n; k++) {
    acc += w[k - 1]!;
    const expected = first + (acc / wsum) * span;
    let best: (typeof runs)[number] | null = null;
    for (const r of runs) {
      if (r.mid <= prevMid + 20) continue;                      // lines are at least 0.2 s
      if (Math.abs(r.mid - expected) > span * 0.3) continue;    // too far from where this line should end
      if (!best || Math.abs(r.mid - expected) < Math.abs(best.mid - expected)) best = r;
    }
    const cut = best ?? { s: Math.round(expected), e: Math.round(expected), mid: expected };
    cuts.push({ s: cut.s, e: cut.e });
    prevMid = cut.mid;
  }
  const out: Span[] = [];
  let from = first;
  for (const c of cuts) { out.push(toSpan(from, Math.max(from + 1, c.s))); from = c.e; }
  out.push(toSpan(from, last));
  return out;
}

/** How many beats (a whole number of bars) a spoken line of `dur` seconds gets, and the playback rate that fits it. */
export function fitToBeats(dur: number, beat: number): { beats: number; rate: number } {
  for (const beats of [4, 8, 12, 16]) {
    const rate = dur / (beats * beat * 0.9);
    if (rate <= 1.25) return { beats, rate: Math.max(0.85, rate) };
  }
  return { beats: 16, rate: 1.25 };
}

/** Bar-aligned scene durations that sum to `total` (cuts land on every `every`-th beat). */
export function planSceneCuts(beats: number[], total: number, n: number, every = 4): number[] {
  n = Math.max(1, Math.round(n));
  if (n === 1 || total <= 0) return [total];
  const cand = beats.filter((b, i) => i % every === 0 && b > 0.8 && b < total - 0.8);
  const cuts: number[] = [];
  let prev = 0;
  for (let k = 1; k < n; k++) {
    const ideal = (total * k) / n;
    let best: number | null = null;
    for (const c of cand) {
      if (c <= prev + 1.2 || c >= total - 0.8) continue;
      if (best === null || Math.abs(c - ideal) < Math.abs(best - ideal)) best = c;
    }
    const t = best !== null && Math.abs(best - ideal) < total / n * 0.6 ? best : Math.max(prev + 1.2, ideal);
    cuts.push(t); prev = t;
  }
  const edges = [0, ...cuts, total];
  return edges.slice(1).map((e, i) => Math.max(0.5, e - edges[i]!));
}

export function beatGrid(bpm: number, total: number, leadIn = SONG_LEAD_IN): number[] {
  const out: number[] = [], p = 60 / bpm;
  for (let t = leadIn; t < total; t += p) out.push(t);
  return out;
}

// ---- AudioBuffer helpers --------------------------------------------------------

function mkBuffer(ch: number, len: number, rate: number): AudioBuffer {
  return new OfflineAudioContext(ch, Math.max(1, len), rate).createBuffer(ch, Math.max(1, len), rate);
}

export function monoOf(b: AudioBuffer): Float32Array {
  const out = new Float32Array(b.length);
  for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < out.length; i++) out[i]! += d[i]! / b.numberOfChannels; }
  return out;
}

export function sliceBuffer(b: AudioBuffer, start: number, dur: number): AudioBuffer {
  const s = Math.max(0, Math.floor(start * b.sampleRate)), len = Math.min(b.length - s, Math.floor(dur * b.sampleRate));
  const out = mkBuffer(b.numberOfChannels, len, b.sampleRate);
  for (let c = 0; c < b.numberOfChannels; c++) out.copyToChannel(b.getChannelData(c).subarray(s, s + len), c);
  return out;
}

/** Join buffers end to end with a short crossfade (used to grow a long song/story across parts). */
export function concatBuffers(parts: AudioBuffer[], xfade = 0.25): AudioBuffer {
  const rate = parts[0]!.sampleRate, ch = 2;
  const xf = Math.floor(xfade * rate);
  const len = parts.reduce((a, p, i) => a + Math.floor(p.duration * rate) - (i ? xf : 0), 0);
  const out = mkBuffer(ch, len, rate);
  let pos = 0;
  parts.forEach((p, i) => {
    const n = Math.min(p.length, Math.floor(p.duration * rate));
    for (let c = 0; c < ch; c++) {
      const src = p.getChannelData(Math.min(c, p.numberOfChannels - 1)), dst = out.getChannelData(c);
      for (let k = 0; k < n; k++) {
        const idx = pos - (i ? xf : 0) + k; if (idx >= len) break;
        let v = src[k]!;
        if (i && k < xf) v *= k / xf;                // fade in over the join
        if (i < parts.length - 1 && k >= n - xf) v *= (n - k) / xf; // fade out into the next part
        dst[idx] = dst[idx]! + v;
      }
    }
    pos += n - (i ? xf : 0);
  });
  return out;
}

function reverbImpulse(ctx: BaseAudioContext, seconds = 0.9): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds), buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
  return buf;
}

function normalize(b: AudioBuffer, peak = 0.95): AudioBuffer {
  let m = 0;
  for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]!)); }
  if (m > 0.001) { const k = peak / m; for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = d[i]! * k; } }
  return b;
}

// ---- song -----------------------------------------------------------------------

export interface SongSectionIn { label: string; lines: string[]; chorus: boolean; voice?: AudioBuffer | null }
export interface AssembledSong {
  buffer: AudioBuffer; seconds: number; bpm: number; beats: number[];
  lines: TimedLine[]; sections: { label: string; start: number; end: number; chorus: boolean }[];
  plan: SongPlan;
}

const INTRO_BARS = 2, OUTRO_BARS = 1, MAX_BARS = 80;

export async function assembleSong(sections: SongSectionIn[], base: SongPlan, vocals: boolean): Promise<AssembledSong> {
  const bpm = Math.min(150, Math.max(60, base.tempo || 100));
  const beat = 60 / bpm, bar = beat * 4;
  interface Placed { text: string; section: string; beatPos: number; span: Span | null; rate: number; voice: AudioBuffer | null; beats: number }
  const placed: Placed[] = [];
  const secBars: { label: string; startBar: number; bars: number; chorus: boolean }[] = [];
  let bars = vocals ? INTRO_BARS : 0;
  for (const s of sections) {
    const lines = s.lines.filter(Boolean);
    if (!lines.length) continue;
    const startBar = bars;
    let beatPos = bars * 4;
    const spans = vocals && s.voice ? splitBySilence(monoOf(s.voice), s.voice.sampleRate, lines.length, lines.map((l) => l.length)) : null;
    lines.forEach((text, i) => {
      const span = spans?.[i] ?? null;
      const fit = span ? fitToBeats(span.end - span.start, beat) : { beats: 4, rate: 1 };
      placed.push({ text, section: s.label, beatPos, span, rate: fit.rate, voice: s.voice ?? null, beats: fit.beats });
      beatPos += fit.beats;
    });
    bars = Math.ceil(beatPos / 4);
    secBars.push({ label: s.label, startBar, bars: bars - startBar, chorus: s.chorus });
  }
  bars += vocals ? OUTRO_BARS : 0;
  if (!secBars.length) bars = Math.max(bars, 8);
  if (bars > MAX_BARS) throw new Error('song_too_long');
  const lift: boolean[] = Array.from({ length: bars }, () => false);
  for (const s of secBars) for (let b = s.startBar; b < s.startBar + s.bars; b++) lift[b] = s.chorus;

  const plan: SongPlan = { ...base, tempo: bpm, bars, lift, leadScale: vocals ? 0.45 : 1 };
  const music = await renderSong(plan);
  const mb = music.buffer;
  const ctx = new OfflineAudioContext(2, mb.length, mb.sampleRate);
  const master = ctx.createGain(); master.gain.value = 0.92;
  const comp = ctx.createDynamicsCompressor(); master.connect(comp); comp.connect(ctx.destination);

  const timed: TimedLine[] = [];
  const musicGain = ctx.createGain();
  const hi = vocals ? 0.6 : 0.9, lo = 0.3;
  musicGain.gain.setValueAtTime(hi, 0);
  const src = ctx.createBufferSource(); src.buffer = mb; src.connect(musicGain); musicGain.connect(master); src.start(0);

  if (vocals) {
    const wet = ctx.createGain(); wet.gain.value = 0.16;
    const conv = ctx.createConvolver(); conv.buffer = reverbImpulse(ctx); conv.connect(wet); wet.connect(master);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 110;
    hp.connect(master); hp.connect(conv);
    for (const p of placed) {
      const when = SONG_LEAD_IN + p.beatPos * beat;
      if (!p.voice || !p.span) { timed.push({ text: p.text, start: when, end: when + p.beats * beat, section: p.section }); continue; }
      const len = (p.span.end - p.span.start) / p.rate;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(1.15, when + 0.01);
      g.gain.setValueAtTime(1.15, Math.max(when + 0.01, when + len - 0.03)); g.gain.linearRampToValueAtTime(0, when + len);
      const v = ctx.createBufferSource(); v.buffer = p.voice; v.playbackRate.value = p.rate;
      v.connect(g); g.connect(hp);
      v.start(when, p.span.start, p.span.end - p.span.start);
      // Duck the band under the voice.
      musicGain.gain.setValueAtTime(hi, Math.max(0, when - 0.12));
      musicGain.gain.linearRampToValueAtTime(lo, when);
      musicGain.gain.setValueAtTime(lo, when + len);
      musicGain.gain.linearRampToValueAtTime(hi, when + len + 0.3);
      timed.push({ text: p.text, start: when, end: when + len, section: p.section });
    }
  }
  const mixed = normalize(await ctx.startRendering());
  const total = mixed.duration;
  const beats: number[] = [];
  for (let i = 0; i < bars * 4; i++) beats.push(SONG_LEAD_IN + i * beat);
  return {
    buffer: mixed, seconds: total, bpm, beats, lines: timed, plan,
    sections: secBars.map((s) => ({ label: s.label, start: SONG_LEAD_IN + s.startBar * bar, end: SONG_LEAD_IN + (s.startBar + s.bars) * bar, chorus: s.chorus })),
  };
}

// ---- narration ------------------------------------------------------------------

export interface NarrationOut { buffer: AudioBuffer; spans: Span[] }

/** Lay narration clips one after another (with breathing gaps) over an optional ducked music bed. */
export async function mixNarration(voices: AudioBuffer[], opts: { music?: AudioBuffer | null; gap?: number; gaps?: number[] } = {}): Promise<NarrationOut> {
  const gap = opts.gap ?? 0.45;
  const spans: Span[] = [];
  let t = 0.3;
  voices.forEach((v, i) => { spans.push({ start: t, end: t + v.duration }); t += v.duration + (opts.gaps?.[i] ?? gap); });
  const total = t + 0.8;
  const rate = opts.music?.sampleRate ?? 44100;
  const ctx = new OfflineAudioContext(2, Math.ceil(total * rate), rate);
  const master = ctx.createGain(); master.gain.value = 0.95; master.connect(ctx.destination);
  if (opts.music) {
    const g = ctx.createGain(); const hi = 0.32, lo = 0.12;
    g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(hi, 1.2);
    spans.forEach((s) => {
      g.gain.setValueAtTime(hi, Math.max(0, s.start - 0.2)); g.gain.linearRampToValueAtTime(lo, s.start);
      g.gain.setValueAtTime(lo, s.end); g.gain.linearRampToValueAtTime(hi, s.end + 0.5);
    });
    g.gain.setValueAtTime(hi, Math.max(0, total - 2)); g.gain.linearRampToValueAtTime(0, total);
    const src = ctx.createBufferSource(); src.buffer = opts.music; src.loop = true; src.connect(g); g.connect(master); src.start(0);
  }
  voices.forEach((v, i) => {
    const s = ctx.createBufferSource(); s.buffer = v;
    const g = ctx.createGain(); g.gain.value = 1.1;
    s.connect(g); g.connect(master); s.start(spans[i]!.start);
  });
  return { buffer: normalize(await ctx.startRendering()), spans };
}
