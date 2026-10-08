import { describe, it, expect } from 'vitest';
import { diffSheets, diffToCsv } from '../../src/diff/sheetDiff';

describe('sheet diff', () => {
  const a = [['id', 'name', 'qty'], ['1', 'apple', '3'], ['2', 'pear', '5'], ['3', 'fig', '1']];
  it('marks changed cells and counts them', () => {
    const b = [['id', 'name', 'qty'], ['1', 'apple', '4'], ['2', 'pear', '5'], ['3', 'fig', '1']];
    const d = diffSheets(a, b);
    expect(d.counts).toMatchObject({ same: 3, changed: 1, added: 0, removed: 0, cells: 1 });
  });
  it('an inserted row does not make the rows below it "changed"', () => {
    const b = [a[0]!, a[1]!, ['9', 'kiwi', '7'], a[2]!, a[3]!];
    const d = diffSheets(a, b);
    expect(d.counts).toMatchObject({ added: 1, removed: 0, changed: 0, same: 4 });
  });
  it('aligns by key column when rows are reordered', () => {
    const b = [a[0]!, a[3]!, a[1]!, ['2', 'pear', '6']];
    const d = diffSheets(a, b, { keyCol: 0 });
    expect(d.counts).toMatchObject({ changed: 1, removed: 0, added: 0, same: 3 });
  });
  it('loose mode ignores case, spaces and 1 vs 1.0', () => {
    const b = [['id', 'name', 'qty'], ['1', ' Apple ', '3.0'], a[2]!, a[3]!];
    expect(diffSheets(a, b).counts.changed).toBe(1);
    expect(diffSheets(a, b, { loose: true }).counts.changed).toBe(0);
  });
  it('reports removed rows and exports a CSV report', () => {
    const d = diffSheets(a, [a[0]!, a[1]!]);
    expect(d.counts.removed).toBe(2);
    expect(diffToCsv(d)).toContain('removed,3,,');
  });
});

import { deltaText } from '../../src/diff/SheetCompare';
describe('numeric delta', () => {
  it('shows absolute and percent change for numbers only', () => {
    expect(deltaText('3', '4')).toBe('+1 (+33.3%)');
    expect(deltaText('$1,000', '$900')).toBe('-100 (-10%)');
    expect(deltaText('0', '5')).toBe('+5');
    expect(deltaText('apple', 'pear')).toBe('');
    expect(deltaText('2', '2.0')).toBe('');
  });
});
