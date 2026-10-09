// WebAudio synth sound effects. No assets: each cue is a tiny oscillator
// envelope, shaped by a preset (wave type + pitch/length multipliers).
export type SfxCue = 'jump' | 'coin' | 'hurt' | 'stomp' | 'spring' | 'win' | 'lose' | 'tap';

interface Preset { wave: OscillatorType; pitch: number; len: number; vol: number }
const PRESETS: Record<string, Preset> = {
  retro: { wave: 'square', pitch: 1, len: 1, vol: 0.07 },
  soft: { wave: 'sine', pitch: 0.85, len: 1.3, vol: 0.14 },
  arcade: { wave: 'sawtooth', pitch: 1.25, len: 0.85, vol: 0.06 },
};

// [start Hz, end Hz, seconds, delay]
const CUES: Record<SfxCue, [number, number, number, number][]> = {
  jump: [[260, 620, 0.16, 0]],
  coin: [[880, 880, 0.07, 0], [1320, 1320, 0.14, 0.07]],
  hurt: [[300, 90, 0.3, 0]],
  stomp: [[420, 160, 0.12, 0], [200, 90, 0.1, 0.06]],
  spring: [[200, 900, 0.22, 0]],
  win: [[523, 523, 0.1, 0], [659, 659, 0.1, 0.1], [784, 784, 0.1, 0.2], [1047, 1047, 0.3, 0.3]],
  lose: [[400, 300, 0.2, 0], [300, 200, 0.2, 0.2], [200, 90, 0.4, 0.4]],
  tap: [[600, 500, 0.05, 0]],
};

export interface Sfx { play(cue: SfxCue): void; setPreset(id: string): void; close(): void }

export function createSfx(presetId: string): Sfx {
  let preset = presetId;
  let ac: AudioContext | null = null;
  const ctxOf = (): AudioContext | null => {
    if (ac) return ac;
    const AC = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    try { ac = new AC(); } catch { ac = null; }
    return ac;
  };
  return {
    setPreset(id) { preset = id; },
    play(cue) {
      const p = PRESETS[preset];
      if (!p) return;
      const c = ctxOf();
      if (!c) return;
      if (c.state === 'suspended') void c.resume().catch(() => {});
      const t0 = c.currentTime;
      for (const [f0, f1, dur, delay] of CUES[cue]) {
        const o = c.createOscillator(), g = c.createGain();
        const d = dur * p.len, st = t0 + delay * p.len;
        o.type = p.wave;
        o.frequency.setValueAtTime(f0 * p.pitch, st);
        o.frequency.exponentialRampToValueAtTime(Math.max(30, f1 * p.pitch), st + d);
        g.gain.setValueAtTime(p.vol, st);
        g.gain.exponentialRampToValueAtTime(0.0001, st + d);
        o.connect(g); g.connect(c.destination);
        o.start(st); o.stop(st + d + 0.02);
      }
    },
    close() { void ac?.close().catch(() => {}); ac = null; },
  };
}
