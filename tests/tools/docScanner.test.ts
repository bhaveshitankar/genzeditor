import { describe, it, expect } from 'vitest';
import { openDocScanner } from '../../src/tools/DocScanner';

describe('DocScanner', () => {
  it('mounts a start screen and closes cleanly', () => {
    const root = document.createElement('div');
    const s = openDocScanner({ root, onSave: async () => {} });
    expect(root.querySelector('.scan-root')?.textContent).toContain('Take photo');
    s.close();
    expect(root.querySelector('.scan-root')).toBeNull();
  });
});
