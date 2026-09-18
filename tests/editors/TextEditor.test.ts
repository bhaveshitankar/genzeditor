// tests/editors/TextEditor.test.ts
import { describe, it, expect } from 'vitest';
import { TextEditor } from '../../src/editors/TextEditor';

describe('TextEditor', () => {
  it('round-trips document text', () => {
    const host = document.createElement('div');
    const ed = new TextEditor(host, { doc: 'hello', language: 'text' });
    expect(host.querySelector('.cm-editor')).toBeTruthy();
    expect(ed.getValue()).toBe('hello');
    ed.setValue('world');
    expect(ed.getValue()).toBe('world');
    ed.destroy();
  });
});
