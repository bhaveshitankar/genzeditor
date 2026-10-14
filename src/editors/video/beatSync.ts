// Beat-synced auto edit: find the beat of a song, then cut the user's clips/images
// to land on it. Pure functions (no DOM) so the same planner backs the editor and
// the MCP `plan_beat_edit` tool.

export type TransitionType = 'fade' | 'fadeblack' | 'slideleft' | 'wipeleft' | 'circleopen' | 'zoomin';
export type Pace = 'fast' | 'medium' | 'slow';

// Structural subset of AudioBuffer so this module also compiles in the Worker (no DOM lib).
export interface AudioLike { numberOfChannels: number; length: number; sampleRate: number; duration: number; getChannelData(c: number): Float32Array; }

export interface BeatInfo { bpm: number; beats: number[]; }

// Energy-onset envelope at ~11.6 ms hops (mono mixdown).
export function onsetEnvelope(samples: Float32Array, sampleRate: number): { env: Float32Array; hop: number } {
  const hopN = Math.max(1, Math.round(sampleRate * 0.0116));
  const n = Math.floor(samples.length / hopN);
  const energy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * hopN, e = j + hopN; j < e; j++) s += samples[j]! * samples[j]!;
    energy[i] = Math.sqrt(s / hopN);
  }
  const env = new Float32Array(n);
  for (let i = 1; i < n; i++) env[i] = Math.max(0, energy[i]! - energy[i - 1]!);
  return { env, hop: hopN / sampleRate };
}

export function detectBeatsFromEnvelope(env: Float32Array, hop: number): BeatInfo {
  const n = env.length;
  if (n < 50) return { bpm: 120, beats: [] };
  // Tempo: autocorrelation over 70–180 BPM lags, folded into 80–160.
  const minLag = Math.round(60 / 180 / hop), maxLag = Math.round(60 / 70 / hop);
  const ac: number[] = [];
  let bestLag = minLag, best = -1;
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += env[i]! * env[i - lag]!;
    s /= n - lag;
    ac[lag - minLag + 1] = s;
    if (lag >= minLag && lag <= maxLag && s > best) { best = s; bestLag = lag; }
  }
  // Parabolic interpolation: integer lags are ~3% coarse, which drifts the beat grid.
  const k = bestLag - minLag + 1, a = ac[k - 1]!, b = ac[k]!, c = ac[k + 1]!;
  const den = a - 2 * b + c;
  const lagF = bestLag + (den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0);
  let bpm = 60 / (lagF * hop);
  while (bpm < 80) bpm *= 2;
  while (bpm > 160) bpm /= 2;
  const period = 60 / bpm / hop; // in frames
  // Phase: grid offset that collects the most onset energy.
  let bestPhase = 0, bestSum = -1;
  const steps = Math.max(1, Math.floor(period));
  for (let p = 0; p < steps; p++) {
    let s = 0;
    for (let x = p; x < n; x += period) s += env[Math.round(x)] ?? 0;
    if (s > bestSum) { bestSum = s; bestPhase = p; }
  }
  const beats: number[] = [];
  const win = Math.max(1, Math.round(0.04 / hop));
  for (let x = bestPhase; x < n; x += period) {
    let c = Math.round(x), top = env[c] ?? 0;
    for (let k = -win; k <= win; k++) { const v = env[c + k] ?? 0; if (v > top) { top = v; c = c + k; } }
    beats.push(Math.max(0, c * hop));
  }
  return { bpm: Math.round(bpm), beats };
}

export function detectBeats(buf: AudioLike): BeatInfo {
  const ch = buf.numberOfChannels;
  const mono = new Float32Array(buf.length);
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < mono.length; i++) mono[i]! += d[i]! / ch; }
  const { env, hop } = onsetEnvelope(mono, buf.sampleRate);
  return detectBeatsFromEnvelope(env, hop);
}

export interface PlanMedia { kind: 'video' | 'image'; dur: number; }
export interface PlanSegment {
  start: number; end: number;      // timeline seconds
  media: number;                   // index into the media list
  srcIn: number; srcOut: number;   // source range (seconds); images: 0..length
  speed: number;
  transition: { type: TransitionType; dur: number } | null; // into this segment
}
export interface PlanOpts { pace?: Pace; transition?: 'none' | 'auto' | TransitionType; minSeg?: number; }

const PER_CUT: Record<Pace, number> = { fast: 1, medium: 2, slow: 4 };
const AUTO: (TransitionType | null)[] = [null, 'fade', null, 'zoomin', null, 'slideleft', null, 'circleopen'];

export function planBeatEdit(beats: number[], total: number, media: PlanMedia[], opts: PlanOpts = {}): PlanSegment[] {
  if (!media.length || total <= 0) return [];
  const pace = opts.pace ?? 'medium', minSeg = opts.minSeg ?? 0.4;
  const every = PER_CUT[pace];
  // Cut points: every Nth beat, never closer than minSeg to the previous cut or the end.
  const cuts = [0];
  beats.forEach((b, i) => {
    if (i % every !== 0 || b <= 0 || b >= total - minSeg) return;
    if (b - cuts[cuts.length - 1]! >= minSeg) cuts.push(b);
  });
  if (beats.length === 0) { for (let t = 1.5; t < total - minSeg; t += 1.5) cuts.push(t); }
  cuts.push(total);

  const cursor = media.map(() => 0);
  const out: PlanSegment[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const start = cuts[i]!, end = cuts[i + 1]!, need = end - start;
    const mi = i % media.length, m = media[mi]!;
    let srcIn = 0, srcOut = need, speed = 1;
    if (m.kind === 'video') {
      if (m.dur >= need) {
        // Walk through the source so repeats show new footage; wrap when exhausted.
        if (cursor[mi]! + need > m.dur) cursor[mi] = 0;
        srcIn = cursor[mi]!; srcOut = srcIn + need; cursor[mi] = srcOut;
      } else { srcIn = 0; srcOut = m.dur; speed = Math.max(0.25, m.dur / need); }
    }
    let transition: PlanSegment['transition'] = null;
    if (i > 0) {
      const t = opts.transition ?? 'auto';
      const type = t === 'none' ? null : t === 'auto' ? AUTO[(i - 1) % AUTO.length]! : t;
      if (type) transition = { type, dur: Math.min(0.3, Math.max(0.1, need / 3)) };
    }
    out.push({ start, end, media: mi, srcIn, srcOut, speed, transition });
  }
  return out;
}

// Loudest `window` seconds of a song (so a long track yields its best part).
export function loudestWindow(buf: AudioLike, window: number): number {
  if (buf.duration <= window) return 0;
  const d = buf.getChannelData(0), sr = buf.sampleRate, step = sr; // 1 s bins
  const bins: number[] = [];
  for (let s = 0; s + step <= d.length; s += step) { let e = 0; for (let j = s; j < s + step; j += 16) e += d[j]! * d[j]!; bins.push(e); }
  const w = Math.max(1, Math.round(window));
  let best = 0, bestSum = -1, sum = 0;
  for (let i = 0; i < bins.length; i++) {
    sum += bins[i]!; if (i >= w) sum -= bins[i - w]!;
    if (i >= w - 1 && sum > bestSum) { bestSum = sum; best = i - w + 1; }
  }
  return Math.max(0, best);
}
