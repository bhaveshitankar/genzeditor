import { describe, it, expect } from 'vitest';
import { planTimeline, wrapCaption, type ReelScene } from '../../src/ai/reel';

const sc = (seconds: number): ReelScene => ({ image: '', text: '', seconds, motion: 'zoom-in' });
const ab = (d: number) => ({ duration: d }) as unknown as AudioBuffer;
const measure = (s: string) => s.length * 10;

describe('planTimeline', () => {
  it('overlaps scenes by 0.5s', () => {
    expect(planTimeline([sc(3), sc(3), sc(2)])).toEqual([{ start: 0, end: 3 }, { start: 2.5, end: 5.5 }, { start: 5, end: 7 }]);
  });
  it('extends scene to voice duration + 0.5', () => {
    const t = planTimeline([sc(2), sc(2)], [ab(5), null]);
    expect(t[0]).toEqual({ start: 0, end: 5.5 });
    expect(t[1]).toEqual({ start: 5, end: 7 });
  });
  it('handles empty', () => { expect(planTimeline([])).toEqual([]); });
});

describe('wrapCaption', () => {
  it('wraps greedily', () => {
    expect(wrapCaption('aaa bbb ccc ddd', 75, measure)).toEqual(['aaa bbb', 'ccc ddd']);
  });
  it('limits to 3 lines with ellipsis', () => {
    const l = wrapCaption('aaa bbb ccc ddd eee fff ggg', 35, measure);
    expect(l.length).toBe(3);
    expect(l[2].endsWith('…')).toBe(true);
  });
  it('empty text', () => { expect(wrapCaption('  ', 100, measure)).toEqual([]); });
  it('long single word kept', () => { expect(wrapCaption('abcdefghij', 30, measure)).toEqual(['abcdefghij']); });
});
