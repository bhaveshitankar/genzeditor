import { describe, it, expect } from 'vitest';
import { editorKindFor } from '../../src/editors/registry';

describe('editorKindFor', () => {
  it('routes text-family to text', () => {
    for (const k of ['text','code','json','markdown','mermaid'] as const)
      expect(editorKindFor(k)).toBe('text');
  });
  it('routes images to image', () => {
    expect(editorKindFor('image')).toBe('image');
  });
  it('routes binary to a preview-only (non-editable) view', () => {
    expect(editorKindFor('binary')).toBe('binary');
  });
});
