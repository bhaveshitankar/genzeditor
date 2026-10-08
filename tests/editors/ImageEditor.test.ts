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
