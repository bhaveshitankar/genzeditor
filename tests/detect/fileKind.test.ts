import { describe, it, expect } from 'vitest';
import { detectKind } from '../../src/detect/fileKind';

describe('detectKind', () => {
  it('detects by extension', () => {
    expect(detectKind('a.json')).toBe('json');
    expect(detectKind('a.md')).toBe('markdown');
    expect(detectKind('a.mmd')).toBe('mermaid');
    expect(detectKind('a.ts')).toBe('code');
    expect(detectKind('a.txt')).toBe('text');
    expect(detectKind('a.png')).toBe('image');
    expect(detectKind('a.bin')).toBe('binary');
  });
  it('falls back to mime for images', () => {
    expect(detectKind('unknown', 'image/jpeg')).toBe('image');
  });
});
