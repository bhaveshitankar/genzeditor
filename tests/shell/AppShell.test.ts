import { describe, it, expect } from 'vitest';
import { AppShell } from '../../src/shell/AppShell';
import { FileStore, MemoryAdapter } from '../../src/store/opfs';

function readText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsText(blob);
  });
}
function readBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = reject;
    r.readAsArrayBuffer(blob);
  });
}

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

  it('opens command palette with Ctrl+K and lists commands', () => {
    const store = new FileStore(new MemoryAdapter());
    const root = document.createElement('div');
    new AppShell(root, store);

    // Initially palette should be hidden
    const overlay = root.querySelector('.command-palette-overlay') as HTMLElement;
    expect(overlay).toBeTruthy();
    expect(overlay.style.display).toBe('none');

    // Dispatch Ctrl+K
    const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true });
    document.dispatchEvent(event);

    // Palette should be visible
    expect(overlay.style.display).toBe('flex');

    // Should list all commands
    const paletteText = overlay.textContent;
    expect(paletteText).toContain('Upload');
    expect(paletteText).toContain('Find');
    expect(paletteText).toContain('Format JSON');
    expect(paletteText).toContain('Toggle preview');
  });

  it('does not fire a stale listener from a previously-opened file (I2)', async () => {
    const store = new FileStore(new MemoryAdapter());
    const a = await store.save('a.txt', new Blob(['aaa']), 'text');
    const b = await store.save('b.txt', new Blob(['bbb']), 'text');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const shell = new AppShell(root, store);

    await shell.openFile(a.id);
    await shell.openFile(b.id);

    const host = root.querySelector('[data-role="editor-host"]') as HTMLElement;
    // Firing input must not throw (A's handler is detached; only B's is live).
    expect(() => host.dispatchEvent(new Event('input', { bubbles: true }))).not.toThrow();
    root.remove();
  });

  it('flushes a pending autosave before switching files (I3)', async () => {
    const store = new FileStore(new MemoryAdapter());
    const a = await store.save('a.txt', new Blob(['original']), 'text');
    const b = await store.save('b.txt', new Blob(['other']), 'text');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const shell = new AppShell(root, store);

    await shell.openFile(a.id);
    const editor = (shell as any).currentEditor;
    editor.setValue('edited-fast');
    // Trigger the debounced autosave scheduling.
    const host = root.querySelector('[data-role="editor-host"]') as HTMLElement;
    host.dispatchEvent(new Event('input', { bubbles: true }));

    // Switch immediately, within the 250ms debounce window.
    await shell.openFile(b.id);

    const saved = await readText(await store.read(a.id));
    expect(saved).toBe('edited-fast');
    root.remove();
  });

  it('never rewrites a binary file it opens (I4)', async () => {
    const store = new FileStore(new MemoryAdapter());
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x80]);
    const rec = await store.save('data.bin', new Blob([bytes]), 'binary');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const shell = new AppShell(root, store);

    await shell.openFile(rec.id);

    // No editable editor, and a preview-only notice is shown.
    expect(root.querySelector('[data-role="editor-host"] .cm-editor')).toBeFalsy();
    expect(root.querySelector('[data-role="binary-notice"]')).toBeTruthy();

    // Any input must not schedule a save that corrupts the bytes.
    const host = root.querySelector('[data-role="editor-host"]') as HTMLElement;
    host.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));

    const stored = await readBytes(await store.read(rec.id));
    expect([...stored]).toEqual([...bytes]);
    root.remove();
  });
});
