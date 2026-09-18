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
