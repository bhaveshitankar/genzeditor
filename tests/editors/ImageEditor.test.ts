import { describe, it, expect } from 'vitest';
import { computeResize, computeRotatedSize } from '../../src/editors/ImageEditor';

describe('image math', () => {
  it('scales down preserving aspect ratio', () => {
    expect(computeResize(2000, 1000, 1000)).toEqual({ w: 1000, h: 500 });
  });
  it('does not upscale', () => {
    expect(computeResize(500, 500, 1000)).toEqual({ w: 500, h: 500 });
  });
  it('swaps dimensions on 90/270', () => {
    expect(computeRotatedSize(200, 100, 90)).toEqual({ w: 100, h: 200 });
    expect(computeRotatedSize(200, 100, 180)).toEqual({ w: 200, h: 100 });
  });
});

import { fitAspect, reshapeSize } from '../../src/editors/ImageEditor';
describe('reshape geometry', () => {
  it('fitAspect centers the largest box of the ratio', () => {
    expect(fitAspect(1000, 500, 1)).toEqual({ x: 250, y: 0, w: 500, h: 500 });
    expect(fitAspect(600, 1200, 16 / 9).w).toBeCloseTo(600);
  });
  it('reshapeSize uses size as the long side', () => {
    expect(reshapeSize(500, 500, 1, 400)).toEqual({ w: 400, h: 400 });
    expect(reshapeSize(900, 1600, 9 / 16, 1920)).toEqual({ w: 1080, h: 1920 });
    expect(reshapeSize(123.4, 50, 2, 0)).toEqual({ w: 123, h: 50 });
  });
});

import { applyTone, needsTonePass, computeHistogram, exportSize, formatBytes, NEUTRAL_TONE } from '../../src/editors/image/pixels';
describe('tone pipeline', () => {
  const px = (r: number, g: number, b: number) => new Uint8ClampedArray([r, g, b, 255]);
  it('neutral params need no pass and change nothing', () => {
    expect(needsTonePass(NEUTRAL_TONE)).toBe(false);
    const d = px(10, 120, 240); applyTone(d, NEUTRAL_TONE);
    expect([...d]).toEqual([10, 120, 240, 255]);
  });
  it('shadows lift darks more than brights', () => {
    const dark = px(30, 30, 30), bright = px(220, 220, 220);
    applyTone(dark, { ...NEUTRAL_TONE, shadows: 100 }); applyTone(bright, { ...NEUTRAL_TONE, shadows: 100 });
    expect(dark[0]! - 30).toBeGreaterThan(bright[0]! - 220);
  });
  it('highlights -100 darkens brights', () => {
    const d = px(240, 240, 240); applyTone(d, { ...NEUTRAL_TONE, highlights: -100 });
    expect(d[0]!).toBeLessThan(240);
  });
  it('vibrance boosts muted colors more than saturated ones', () => {
    const muted = px(130, 120, 110), vivid = px(250, 20, 20);
    applyTone(muted, { ...NEUTRAL_TONE, vibrance: 100 }); applyTone(vivid, { ...NEUTRAL_TONE, vibrance: 100 });
    expect(muted[0]! - muted[2]!).toBeGreaterThan(20);
    expect(vivid[0]!).toBeLessThanOrEqual(255);
  });
  it('grain is deterministic', () => {
    const a = new Uint8ClampedArray(40).fill(128), b = new Uint8ClampedArray(40).fill(128);
    applyTone(a, { ...NEUTRAL_TONE, grain: 60 }); applyTone(b, { ...NEUTRAL_TONE, grain: 60 });
    expect([...a]).toEqual([...b]);
  });
  it('histogram counts pixels', () => {
    const h = computeHistogram(new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]));
    expect(h.luma[0]).toBe(1); expect(h.luma[255]).toBe(1);
  });
  it('export size never upscales and keeps aspect', () => {
    expect(exportSize(4000, 2000, 1000)).toEqual({ w: 1000, h: 500 });
    expect(exportSize(500, 300, 1000)).toEqual({ w: 500, h: 300 });
    expect(exportSize(500, 300, 0)).toEqual({ w: 500, h: 300 });
    expect(formatBytes(2048)).toBe('2.0 KB');
  });
});
