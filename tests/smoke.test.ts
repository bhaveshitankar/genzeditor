import { describe, it, expect } from 'vitest';
import { AppShell } from '../src/shell/AppShell';
import { FileStore, MemoryAdapter } from '../src/store/opfs';

describe('app bootstrap', () => {
  it('mounts a header with the app name', () => {
    const root = document.createElement('div');
    const store = new FileStore(new MemoryAdapter());
    new AppShell(root, store);
    expect(root.querySelector('header')?.textContent).toContain('GenZ');
  });
});
