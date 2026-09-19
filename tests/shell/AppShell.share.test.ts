import { describe, it, expect, vi } from 'vitest';
import { AppShell } from '../../src/shell/AppShell';
import { FileStore, MemoryAdapter } from '../../src/store/opfs';

describe('AppShell share integration', () => {
  it('renders a Share button after opening a file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ authenticated: false }), { status: 200 })));
    const store = new FileStore(new MemoryAdapter());
    const rec = await store.save('note.md', new Blob(['# hi']), 'markdown');
    const root = document.createElement('div');
    const shell = new AppShell(root, store);
    await shell.openFile(rec.id);
    expect(root.querySelector('[data-role="share-btn"]')).toBeTruthy();
    vi.restoreAllMocks();
  });
});
