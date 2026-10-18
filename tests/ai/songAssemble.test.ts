import { describe, it, expect } from 'vitest';
import { beatGrid, fitToBeats, planSceneCuts, splitBySilence } from '../../src/ai/songAssemble';

const SR = 8000;
// Speech-like bursts (440 Hz) separated by silences, given in seconds.
function track(parts: [number, number][], total: number): Float32Array {
  const x = new Float32Array(Math.round(total * SR));
  for (const [a, b] of parts) for (let i = Math.round(a * SR); i < Math.round(b * SR); i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
  return x;
}

describe('splitBySilence', () => {
  it('cuts at the pauses between lines', () => {
    const x = track([[0.2, 2.0], [2.6, 4.2], [4.9, 7.0]], 7.4);
    const s = splitBySilence(x, SR, 3);
    expect(s).toHaveLength(3);
    expect(s[0]!.end).toBeGreaterThan(1.9); expect(s[0]!.end).toBeLessThan(2.4);
    expect(s[1]!.start).toBeGreaterThan(2.3); expect(s[1]!.end).toBeLessThan(4.7);
    expect(s[2]!.start).toBeGreaterThan(4.3); expect(s[2]!.end).toBeLessThan(7.3);
  });
  it('prefers the pause nearest the expected position (ignores an internal breath)', () => {
    // 4 equal-weight lines; a breath at 1.0s inside line 1 must not be taken as the first cut.
    const x = track([[0.1, 0.9], [1.1, 2.0], [2.5, 4.0], [4.5, 6.0], [6.5, 8.0]], 8.2);
    const s = splitBySilence(x, SR, 4, [2, 2, 2, 2]);
    expect(s).toHaveLength(4);
    expect(s[0]!.end).toBeGreaterThan(1.9);
  });
  it('always returns n spans, even with no pauses at all', () => {
    const x = track([[0, 6]], 6);
    const s = splitBySilence(x, SR, 3);
    expect(s).toHaveLength(3);
    for (let k = 1; k < 3; k++) expect(s[k]!.start).toBeGreaterThanOrEqual(s[k - 1]!.end - 0.1);
  });
  it('handles silence and n=1', () => {
    expect(splitBySilence(new Float32Array(SR), SR, 2)).toHaveLength(2);
    expect(splitBySilence(track([[0.5, 1.5]], 2), SR, 1)).toHaveLength(1);
  });
});

describe('fitToBeats', () => {
  it('gives short lines one bar and long lines more, with a bounded stretch', () => {
    const beat = 0.5; // 120 BPM → bar = 2s
    expect(fitToBeats(1.6, beat).beats).toBe(4);
    expect(fitToBeats(3.0, beat).beats).toBe(8);
    for (const d of [0.4, 1, 2.2, 3.5, 6]) { const f = fitToBeats(d, beat); expect(f.rate).toBeGreaterThanOrEqual(0.85); expect(f.rate).toBeLessThanOrEqual(1.25); }
  });
});

describe('planSceneCuts', () => {
  const beats = beatGrid(120, 60); // a beat every 0.5s from 0.2
  it('sums to the total and lands cuts on bar lines', () => {
    const d = planSceneCuts(beats, 60, 6, 4);
    expect(d).toHaveLength(6);
    expect(d.reduce((a, b) => a + b, 0)).toBeCloseTo(60, 5);
    let t = 0;
    for (const x of d.slice(0, -1)) { t += x; const nearest = Math.min(...beats.filter((_, i) => i % 4 === 0).map((b) => Math.abs(b - t))); expect(nearest).toBeLessThan(0.01); }
  });
  it('falls back to an even split with no beats and handles n=1', () => {
    expect(planSceneCuts([], 30, 3)).toEqual([10, 10, 10]);
    expect(planSceneCuts(beats, 30, 1)).toEqual([30]);
  });
});
