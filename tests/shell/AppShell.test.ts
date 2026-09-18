import { describe, it, expect } from 'vitest';
import { AppShell } from '../../src/shell/AppShell';
import { FileStore, MemoryAdapter } from '../../src/store/opfs';

describe('AppShell', () => {
  it('lists stored files in the drawer', async () => {
    const store = new FileStore(new MemoryAdapter());
    await store.save('note.md', new Blob(['# hi']), 'markdown');
    const root = document.createElement('div');
    const shell = new AppShell(root, store);
    await shell.refreshLibrary();
    expect(root.querySelector('[data-role="file-drawer"]')?.textContent).toContain('note.md');
  });

  it('opens a markdown file into an editor host', async () => {
    const store = new FileStore(new MemoryAdapter());
    const rec = await store.save('note.md', new Blob(['# hi']), 'markdown');
    const root = document.createElement('div');
    const shell = new AppShell(root, store);
    await shell.openFile(rec.id);
    expect(root.querySelector('[data-role="editor-host"] .cm-editor')).toBeTruthy();
    expect(root.querySelector('[data-role="preview"]')).toBeTruthy();
  });
});
