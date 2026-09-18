import { describe, it, expect } from 'vitest';
import { formatJson, toTree } from '../../src/editors/JsonTools';

describe('JsonTools', () => {
  it('formats valid json', () => {
    const r = formatJson('{"a":1}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe('{\n  "a": 1\n}');
  });
  it('reports invalid json', () => {
    expect(formatJson('{oops').ok).toBe(false);
  });
  it('builds a tree', () => {
    const t = toTree('{"a":{"b":2}}');
    expect(t.children?.[0].key).toBe('a');
    expect(t.children?.[0].children?.[0].value).toBe('2');
  });
});
