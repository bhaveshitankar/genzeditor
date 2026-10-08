import { describe, it, expect } from 'vitest';
import {
  applyH, detectQuad, homography, isConvex, makeImg, orderQuad, outputSize, quadFromHull,
  convexHull, warpPerspective, applyFilter, type Pt, type Quad,
} from '../../src/tools/scanCore';

const close = (a: Pt, b: Pt, tol: number) => Math.hypot(a.x - b.x, a.y - b.y) <= tol;

/** Dark image with a bright convex quad painted in (point-in-polygon). */
function synth(w: number, h: number, q: Quad) {
  const img = makeImg(w, h);
  const inside = (x: number, y: number) => q.every((a, i) => {
    const b = q[(i + 1) % 4];
    return (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) >= 0;
  });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = inside(x + 0.5, y + 0.5) ? 235 : 40, i = (y * w + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  return img;
}

describe('scanCore geometry', () => {
  it('orders points clockwise from top-left', () => {
    const q = orderQuad([{ x: 10, y: 90 }, { x: 90, y: 10 }, { x: 10, y: 10 }, { x: 90, y: 90 }]);
    expect(q).toEqual([{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 }]);
    expect(isConvex(q)).toBe(true);
  });

  it('homography maps corners exactly', () => {
    const src = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }];
    const dst = [{ x: 12, y: 7 }, { x: 180, y: 30 }, { x: 160, y: 140 }, { x: 5, y: 120 }];
    const H = homography(src, dst);
    src.forEach((p, i) => expect(close(applyH(H, p.x, p.y), dst[i], 1e-6)).toBe(true));
  });

  it('quadFromHull recovers a rotated rectangle', () => {
    const corners: Quad = [{ x: 50, y: 10 }, { x: 140, y: 60 }, { x: 100, y: 140 }, { x: 10, y: 90 }];
    const pts: Pt[] = [...corners];
    for (let i = 0; i < 4; i++) for (let t = 0.1; t < 1; t += 0.1) {
      const a = corners[i], b = corners[(i + 1) % 4];
      pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    const q = quadFromHull(convexHull(pts))!;
    q.forEach((p, i) => expect(close(p, orderQuad(corners)[i], 1e-6)).toBe(true));
  });

  it('outputSize averages edges and caps long side', () => {
    expect(outputSize([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }])).toEqual({ w: 200, h: 100 });
    expect(outputSize([{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 2500 }, { x: 0, y: 2500 }], 2480)).toEqual({ w: 2480, h: 1240 });
  });
});

describe('scanCore detection & warp', () => {
  it('detects a perspective document on a dark background', () => {
    const truth: Quad = [{ x: 80, y: 40 }, { x: 330, y: 70 }, { x: 310, y: 280 }, { x: 60, y: 260 }];
    const r = detectQuad(synth(400, 320, truth));
    expect(r.found).toBe(true);
    r.quad.forEach((p, i) => expect(close(p, truth[i], 6)).toBe(true));
  });

  it('falls back to an inset full-frame quad on a blank image', () => {
    const r = detectQuad(makeImg(200, 100));
    expect(r.found).toBe(false);
    expect(r.quad[0].x).toBeGreaterThan(0);
  });

  it('warps the document region to a bright rectangle and filters run', async () => {
    const truth: Quad = [{ x: 40, y: 30 }, { x: 160, y: 40 }, { x: 150, y: 170 }, { x: 30, y: 160 }];
    const out = await warpPerspective(synth(200, 200, truth), truth, 2480, async () => {});
    let mean = 0;
    for (let i = 0; i < out.data.length; i += 4) mean += out.data[i];
    expect(mean / (out.width * out.height)).toBeGreaterThan(220);
    for (const f of ['magic', 'gray', 'bw', 'lighten', 'original'] as const) {
      const r = applyFilter(out, f);
      expect(r.width).toBe(out.width);
    }
  });
});
