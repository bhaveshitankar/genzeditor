// Procedural song performer: turns a musical plan (mood / tempo / key / mode)
// into a WAV with chords, bass, drums and a lead melody using WebAudio. It runs
// entirely in the browser, so it is free and works offline. A seed makes the
// same plan reproducible; a different seed gives a new arrangement.

export interface SongPlan {
  mood: 'chill' | 'upbeat' | 'sad' | 'epic' | 'lofi';
  tempo: number;          // BPM
  key: string;            // C D E F G A B
  minor: boolean;
  bars?: number;          // default 16
  seed?: number;
}

const KEY_SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
// Chord roots as scale degrees (0-based) — classic progressions per mode.
const PROG_MAJOR = [[0, 4, 5, 3], [0, 5, 3, 4], [0, 3, 4, 3], [0, 2, 3, 4]];
const PROG_MINOR = [[0, 5, 2, 6], [0, 3, 6, 5], [0, 5, 3, 4], [0, 6, 5, 4]];

interface Style { wave: OscillatorType; lead: OscillatorType; swing: number; drums: boolean; hatEvery: number; leadDensity: number; padGain: number; lowpass: number }
const STYLES: Record<SongPlan['mood'], Style> = {
  chill: { wave: 'triangle', lead: 'sine', swing: 0.06, drums: true, hatEvery: 1, leadDensity: 0.45, padGain: 0.16, lowpass: 2600 },
  lofi: { wave: 'triangle', lead: 'triangle', swing: 0.12, drums: true, hatEvery: 1, leadDensity: 0.35, padGain: 0.18, lowpass: 1800 },
  upbeat: { wave: 'sawtooth', lead: 'square', swing: 0, drums: true, hatEvery: 0.5, leadDensity: 0.75, padGain: 0.1, lowpass: 5200 },
  sad: { wave: 'sine', lead: 'triangle', swing: 0, drums: false, hatEvery: 1, leadDensity: 0.4, padGain: 0.2, lowpass: 2200 },
  epic: { wave: 'sawtooth', lead: 'sawtooth', swing: 0, drums: true, hatEvery: 1, leadDensity: 0.55, padGain: 0.14, lowpass: 3800 },
};

function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

export const SONG_RATE = 44100;

export async function renderSong(plan: SongPlan): Promise<{ buffer: AudioBuffer; seconds: number }> {
  const bpm = Math.min(170, Math.max(55, plan.tempo || 100));
  const bars = Math.min(32, Math.max(4, plan.bars ?? 16));
  const beat = 60 / bpm, bar = beat * 4;
  const seconds = bars * bar + 2.5;
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SONG_RATE), SONG_RATE);
  const rand = rng(plan.seed ?? 1337);
  const st = STYLES[plan.mood] ?? STYLES.chill;
  const scale = plan.minor ? MINOR : MAJOR;
  const root = 48 + (KEY_SEMI[plan.key] ?? 0); // C3-ish
  const progs = plan.minor ? PROG_MINOR : PROG_MAJOR;
  const prog = progs[Math.floor(rand() * progs.length)]!;
  const degree = (d: number, oct = 0): number => root + scale[((d % 7) + 7) % 7]! + 12 * (Math.floor(d / 7) + oct);

  const master = ctx.createGain(); master.gain.value = 0.8;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = st.lowpass;
  const comp = ctx.createDynamicsCompressor();
  master.connect(lp); lp.connect(comp); comp.connect(ctx.destination);

  const tone = (type: OscillatorType, freq: number, t: number, dur: number, gain: number, attack = 0.02, rel = 0.15, detune = 0): void => {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq; o.detune.value = detune;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.setValueAtTime(gain, t + Math.max(attack, dur - rel)); g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.05);
  };
  const noiseBuf = ctx.createBuffer(1, SONG_RATE, SONG_RATE);
  { const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = rand() * 2 - 1; }
  const noise = (t: number, dur: number, gain: number, hp: number): void => {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp;
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f); f.connect(g); g.connect(master); s.start(t, rand() * 0.5); s.stop(t + dur);
  };
  const kick = (t: number): void => {
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.25);
  };

  // A 4-note motif per section keeps the lead melodic instead of random noodling.
  const motif = Array.from({ length: 8 }, () => Math.floor(rand() * 5) * 1 + (rand() < 0.5 ? 0 : 2));
  for (let b = 0; b < bars; b++) {
    const t0 = b * bar + 0.2;
    const section = Math.floor(b / 4);                 // 4-bar phrases
    const chordDeg = prog[b % 4]!;
    const lift = st.drums && section % 2 === 1 ? 1 : 0;  // choruses are a bit fuller
    // Pad: root, third, fifth (stacked scale steps), slightly detuned for width.
    for (const [i, off] of [0, 2, 4].entries()) {
      tone(st.wave, hz(degree(chordDeg + off, 1)), t0, bar * 0.98, st.padGain * (0.8 + 0.1 * lift), 0.08, 0.3, (i - 1) * 6);
    }
    // Bass: root on beat 1, fifth on beat 3.
    tone('triangle', hz(degree(chordDeg, 0)), t0, beat * 1.9, 0.34, 0.01, 0.1);
    tone('triangle', hz(degree(chordDeg + (rand() < 0.5 ? 4 : 0), 0)), t0 + beat * 2, beat * 1.9, 0.3, 0.01, 0.1);
    // Drums
    if (st.drums) {
      for (let q = 0; q < 4; q++) {
        const tq = t0 + q * beat;
        if (q === 0 || q === 2) kick(tq);
        if (q === 1 || q === 3) noise(tq, 0.14, 0.32, 1800);
      }
      const hats = Math.round(4 / st.hatEvery) * 2;
      for (let h = 0; h < hats; h++) {
        const swing = h % 2 ? st.swing * beat : 0;
        noise(t0 + (h * beat) / (hats / 4) + swing, 0.04, 0.09, 7000);
      }
    }
    // Lead: eighth-note grid, motif walks the scale around the current chord.
    for (let n = 0; n < 8; n++) {
      if (rand() > st.leadDensity + 0.15 * lift) continue;
      const step = motif[(n + b * 3) % motif.length]! + chordDeg;
      tone(st.lead, hz(degree(step, 2)), t0 + n * (beat / 2) + (n % 2 ? st.swing * beat : 0), beat * (rand() < 0.3 ? 0.9 : 0.45), 0.13, 0.015, 0.1);
    }
  }
  // Final chord rings out.
  const endT = bars * bar + 0.2;
  for (const off of [0, 2, 4]) tone(st.wave, hz(degree(prog[0]! + off, 1)), endT, 2.2, st.padGain, 0.05, 1.6);
  tone('triangle', hz(degree(prog[0]!, 0)), endT, 2.2, 0.32, 0.02, 1.5);

  return { buffer: await ctx.startRendering(), seconds };
}

/** Encode an AudioBuffer as 16-bit PCM WAV. */
export function audioBufferToWav(buf: AudioBuffer): Blob {
  const ch = buf.numberOfChannels, len = buf.length, bytes = 44 + len * ch * 2;
  const v = new DataView(new ArrayBuffer(bytes));
  const w = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, bytes - 8, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, ch, true); v.setUint32(24, buf.sampleRate, true); v.setUint32(28, buf.sampleRate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, len * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, i) => buf.getChannelData(i));
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) { const s = Math.max(-1, Math.min(1, chans[c]![i]!)); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  return new Blob([v], { type: 'audio/wav' });
}

/** Sensible defaults for a free-text mood word, so the song works even without the AI lyric step. */
export function planFromText(text: string, seed = Date.now() % 100000): SongPlan {
  const t = text.toLowerCase();
  const mood: SongPlan['mood'] = /sad|melanchol|cry|lonely|rain|heartbreak/.test(t) ? 'sad'
    : /epic|battle|hero|cinematic|dramatic/.test(t) ? 'epic'
    : /lofi|lo-fi|study|coffee|relax/.test(t) ? 'lofi'
    : /party|happy|dance|upbeat|summer|fun|energetic/.test(t) ? 'upbeat' : 'chill';
  const tempo = { chill: 88, lofi: 78, upbeat: 124, sad: 70, epic: 104 }[mood];
  const keys = Object.keys(KEY_SEMI);
  return { mood, tempo, key: keys[seed % keys.length]!, minor: mood === 'sad' || mood === 'epic', seed };
}
